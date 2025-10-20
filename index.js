// server/index.js — Express 5 + Firebase RTDB + Gemini (SYSTEM_INSTRUCTION only)
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
const DEBUG = String(process.env.DEBUG_GEMINI || "0") === "1";

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
      return tb - ta; // newest first
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
    updatedAt: now,
    // If you want per-session system prompts someday:
    // systemPrompt: req.body?.systemPrompt || null
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

  // 1) user message
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "user", content, createdAt: nowIso, createdAtMs: nowMs
  });

  // 2) Gemini reply (SYSTEM_INSTRUCTION is the only style/length control)
  const systemText =
    (sess?.systemPrompt && String(sess.systemPrompt).trim()) ||
    (process.env.SYSTEM_INSTRUCTION || "").trim() ||
    ""; // exactly what you set in Render

  let replyText = "";
  try {
    replyText = await generateTextFromGemini(content, systemText);
    if (!replyText) replyText = "Sorry — no text came back from the model."; // very rare with settings below
  } catch (e) {
    console.error("Gemini call failed:", e);
    replyText = "Sorry — LLM is unavailable right now.";
  }

  // 3) assistant message
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "assistant", content: String(replyText),
    createdAt: new Date().toISOString(), createdAtMs: Date.now()
  });

  // 4) session metadata
  await sessRef.update({
    updatedAt: new Date().toISOString(),
    title: (sess.title && sess.title.trim()) ? sess.title : content.slice(0, 40)
  });

  res.json({ reply: replyText });
});

// ── Gemini helpers (2.5 Pro-first, plain text, minimal constraints) ──────────
function extractGeminiText(raw, ct) {
  if (ct && ct.includes("text/plain")) return (raw || "").toString().trim();
  if (typeof raw === "string" && raw.length && raw[0] !== "{" && raw[0] !== "[") {
    return raw.trim();
  }
  try {
    const j = JSON.parse(raw);
    const parts = j?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      let txt = "";
      for (const p of parts) if (p && typeof p.text === "string") txt += p.text;
      txt = txt.trim();
      if (txt) return txt;
    }
    if (typeof j?.output_text === "string" && j.output_text.trim()) return j.output_text.trim();
    return "";
  } catch {
    return (raw || "").toString().trim();
  }
}

async function callGeminiJSON({ history, model, ver, systemText }) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return { status: 500, json: { error: "GEMINI_API_KEY not set" }, ct: "application/json" };

  const url = `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(KEY)}`;

  const body = {
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    contents: history, // multi-turn history (user/model)
    generationConfig: {
      // Bigger cap so it can actually finish long answers
      maxOutputTokens: 2048,
      temperature: 0.7,
      topK: 64,
      topP: 0.95,
      // Ask for JSON so we can read finishReason and loop
      responseMimeType: "application/json",
      response_mime_type: "application/json"
    },
    // Loosen safety so benign FGC content doesn't get blanked
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ]
  };

  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  const ct = r.headers.get("content-type") || "application/json";
  return { status: r.status, json, ct };
}


async function generateTextFromGemini(originalPrompt, systemText) {
  const base = (process.env.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");
  const versions = ["v1beta", "v1"];
  const models = Array.from(new Set([
    base, "gemini-2.5-pro", "gemini-2.5-flash", "gemini-1.5-pro-001", "gemini-1.5-flash-001"
  ]));

  for (const ver of versions) {
    for (const m of models) {
      // Start the conversation with just your user prompt
      let history = [{ role: "user", parts: [{ text: originalPrompt }]}];
      let acc = "";

      for (let i = 0; i < 4; i++) { // up to 4 segments if the model keeps hitting MAX_TOKENS
        const out = await callGeminiJSON({ history, model: m, ver, systemText });
        if (out.status === 404 || out.status === 401 || out.status === 403) break; // try next model
        const cand = out.json?.candidates?.[0];
        const parts = cand?.content?.parts || [];
        const chunk = parts.map(p => p?.text || "").join("");
        const finish = cand?.finishReason || cand?.finish_reason || "";

        if (chunk) {
          acc += (acc ? "\n\n" : "") + chunk;
          // Continue the conversation so the next call can pick up where it stopped
          history.push({ role: "model", parts: [{ text: chunk }] });
        }

        if (finish !== "MAX_TOKENS") break; // done (STOP/SAFETY/etc.)
        // Ask it to continue
        history.push({ role: "user", parts: [{ text: "Continue." }] });
      }

      if (acc.trim()) return acc.trim(); // got something meaningful
      // else try next model/version in cascade
    }
  }
  return "";
}


// ── Test route ───────────────────────────────────────────────────────────────
app.get("/test-hf", async (req, res) => {
  const systemText = (process.env.SYSTEM_INSTRUCTION || "").trim();
  const text = await generateTextFromGemini(req.query.prompt || "Say hello from Gemini!", systemText);
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
