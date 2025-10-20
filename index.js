// server/index.js — Express 5 + Firebase RTDB + Gemini + static frontend (ESM)
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import admin from "firebase-admin";

// ── Firebase Admin ────────────────────────────────────────────────────────────
const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : null;

admin.initializeApp(
  saJson
    ? { credential: admin.credential.cert(saJson), databaseURL: process.env.RTDB_URL }
    : { credential: admin.credential.applicationDefault(), databaseURL: process.env.RTDB_URL }
);

const db = admin.database();

// ── App ───────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 9188);

app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ── Health ───────────────────────────────────────────────────────────────────
app.get("/ping", (_req, res) => res.json({ ok: true }));

// ── Auth guard (Firebase ID token) ───────────────────────────────────────────
async function authGuard(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.sendStatus(403);
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { uid: decoded.uid };
    next();
  } catch (e) {
    console.error("verifyIdToken error:", e?.message || e);
    res.sendStatus(403);
  }
}

// ── Sessions ─────────────────────────────────────────────────────────────────
app.get("/api/sessions", authGuard, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const snap = await db
    .ref("sessions")
    .orderByChild("ownerUid")
    .equalTo(req.user.uid)
    .once("value");

  const val = snap.val() || {};
  const list = Object.entries(val)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : (a.createdAt ? Date.parse(a.createdAt) : 0);
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : (b.createdAt ? Date.parse(b.createdAt) : 0);
      return tb - ta;
    });

  res.json(list);
});

app.post("/api/sessions", authGuard, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const now = new Date().toISOString();
  const ref = db.ref("sessions").push();
  await ref.set({
    ownerUid: req.user.uid,
    title: req.body?.title || "New chat",
    createdAt: now,
    updatedAt: now
    // Future: per-session systemPrompt? (optional)
  });
  res.json({ id: ref.key });
});

// ── Messages (GET + POST) ────────────────────────────────────────────────────
app.get("/api/sessions/:id/messages", authGuard, async (req, res) => {
  res.set("Cache-Control", "no-store");

  const sess = (await db.ref(`sessions/${req.params.id}`).once("value")).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const snap = await db.ref(`messagesBySession/${req.params.id}`).once("value");
  const out = [];
  snap.forEach(c => { out.push({ id: c.key, ...c.val() }); });

  out.sort((a, b) => {
    const ta = (a.createdAtMs != null) ? a.createdAtMs : (a.createdAt ? Date.parse(a.createdAt) : 0);
    const tb = (b.createdAtMs != null) ? b.createdAtMs : (b.createdAt ? Date.parse(b.createdAt) : 0);
    return ta - tb;
  });

  res.json(out);
});

app.post("/api/sessions/:id/messages", authGuard, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: "content required" });

  const sessRef = db.ref(`sessions/${req.params.id}`);
  const sess = (await sessRef.once("value")).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const msgsRef = db.ref(`messagesBySession/${req.params.id}`);
  const nowIso = new Date().toISOString();
  const nowMs  = Date.now();

  // 1) store YOUR message
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "user", content, createdAt: nowIso, createdAtMs: nowMs
  });

  // 2) build history + call Gemini (SYSTEM_INSTRUCTION is the only knob)
  const systemText =
    (sess?.systemPrompt && String(sess.systemPrompt).trim()) ||
    (process.env.SYSTEM_INSTRUCTION || "").trim() ||
    "";

  let replyText = "";
  try {
    const history = await rtdbToGeminiHistory(db, req.params.id, content);
    replyText = await generateWithHistory(history, systemText);
    if (!replyText) replyText = "Sorry — no text came back from the model.";
  } catch (e) {
    console.error("Gemini call failed:", e);
    replyText = "Sorry — LLM is unavailable right now.";
  }

  // 3) store ASSISTANT message
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "assistant", content: String(replyText),
    createdAt: new Date().toISOString(), createdAtMs: Date.now()
  });

  // 4) update session metadata
  await sessRef.update({
    updatedAt: new Date().toISOString(),
    title: (sess.title && sess.title.trim()) ? sess.title : content.slice(0, 40)
  });

  res.json({ reply: replyText });
});

// ── Gemini helpers (history + continuation) ───────────────────────────────────
async function rtdbToGeminiHistory(db, sessionId, newUserText) {
  const snap = await db.ref(`messagesBySession/${sessionId}`)
    .orderByChild("createdAtMs")
    .limitToLast(12)
    .once("value");

  const msgs = [];
  snap.forEach(c => msgs.push({ id: c.key, ...c.val() }));
  msgs.sort((a,b)=>{
    const ta = (a.createdAtMs ?? (a.createdAt ? Date.parse(a.createdAt) : 0)) || 0;
    const tb = (b.createdAtMs ?? (b.createdAt ? Date.parse(b.createdAt) : 0)) || 0;
    return ta - tb;
  });

  const history = [];
  for (const m of msgs) {
    const text = (m.content ?? "").toString();
    if (!text) continue;
    const role = m.role === "assistant" ? "model" : "user";
    history.push({ role, parts: [{ text }] });
  }
  if (newUserText && newUserText.trim()) {
    history.push({ role: "user", parts: [{ text: newUserText }] });
  }
  return history;
}

async function generateWithHistory(history, systemText) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return "";

  const versions = ["v1beta", "v1"];
  const models   = Array.from(new Set([
    (process.env.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//,""),
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-1.5-pro-001",
    "gemini-1.5-flash-001",
  ]));

  const post = async (ver, model, hist) => {
    const url = `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(KEY)}`;
    const body = {
      systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
      contents: hist,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.7,
        topK: 64,
        topP: 0.95,
        responseMimeType: "text/plain",
        response_mime_type: "text/plain"
      },
      safetySettings: [
        { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
      ]
    };
    const r = await fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    const ct = r.headers.get("content-type") || "";
    const txt = await r.text();
    return { status:r.status, ct, txt };
  };

  for (const ver of versions) {
    for (const model of models) {
      let acc = "";
      let hist = history.slice();

      for (let i=0; i<4; i++) {
        const { status, ct, txt } = await post(ver, model, hist);
        if (status === 404 || status === 401 || status === 403) break;

        if (ct.includes("text/plain")) {
          const chunk = (txt || "").trim();
          if (chunk) acc += (acc ? "\n\n" : "") + chunk;
          return acc.trim();
        } else {
          try {
            const j = JSON.parse(txt);
            const cand  = j?.candidates?.[0] || {};
            const parts = cand?.content?.parts || [];
            const chunk = parts.map(p=>p?.text||"").join("").trim();
            const finish = cand?.finishReason || cand?.finish_reason || "";

            if (chunk) {
              acc += (acc ? "\n\n" : "") + chunk;
              if (finish !== "MAX_TOKENS") return acc.trim();

              // continue if truncated
              hist.push({ role:"model", parts:[{ text: chunk }] });
              hist.push({ role:"user",  parts:[{ text: "Continue." }] });
              continue;
            } else {
              // no chunk; bail to next model
              break;
            }
          } catch {
            // Weird payload; return whatever we have
            return (acc || txt).trim();
          }
        }
      }
      if (acc.trim()) return acc.trim();
    }
  }
  return "";
}

// ── Test route ───────────────────────────────────────────────────────────────
app.get("/test-hf", async (req, res) => {
  const systemText = (process.env.SYSTEM_INSTRUCTION || "").trim();
  const history = [{ role:"user", parts:[{ text: req.query.prompt || "Say hello from Gemini!" }]}];
  const text = await generateWithHistory(history, systemText);
  if (!text) return res.status(502).json({ error: "No text from Gemini" });
  res.type("text/plain").send(text);
});

// ── Static frontend (index.html + client.js in /server/public) ───────────────
const clientDir = path.resolve(__dirname, "public");
app.use(express.static(clientDir));

// SPA fallback
app.use((req, res, next) => {
  if (
    req.method === "GET" &&
    !req.path.startsWith("/api/") &&
    !req.path.startsWith("/test-") &&
    !req.path.includes(".") &&
    req.accepts("html")
  ) {
    return res.sendFile(path.join(clientDir, "index.html"));
  }
  next();
});

// 404 last
app.use((_req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => {
  console.log(`Web + API running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) console.warn("⚠️  GEMINI_API_KEY is not set (affects replies).");
  if (!process.env.RTDB_URL) console.warn("⚠️  RTDB_URL not set (Firebase DB).");
});
