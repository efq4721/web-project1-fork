// server/index.js — Express 5, Firebase RTDB persistence, Gemini replies, static frontend
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import admin from "firebase-admin";

// ---- Firebase Admin (Render/env) ----
const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : null;

admin.initializeApp(
  saJson
    ? { credential: admin.credential.cert(saJson), databaseURL: process.env.RTDB_URL }
    : { credential: admin.credential.applicationDefault(), databaseURL: process.env.RTDB_URL }
);

const db = admin.database();

// ---- App + static ----
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 9188);

app.use(express.json());
app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`); next(); });

const clientDir = path.resolve(__dirname, "public");   // put index.html + client.js here
app.use(express.static(clientDir));

// ---- Health ----
app.get("/ping", (_req, res) => res.json({ ok: true }));

// ---- Auth guard (Firebase ID token from client) ----
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

// ---- Sessions (persisted in RTDB) ----
app.get("/api/sessions", authGuard, async (req, res) => {
  const snap = await db.ref("sessions").orderByChild("ownerUid").equalTo(req.user.uid).once("value");
  const val = snap.val() || {};
  const list = Object.entries(val).map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(list);
});

app.post("/api/sessions", authGuard, async (req, res) => {
  const now = new Date().toISOString();
  const ref = db.ref("sessions").push();
  await ref.set({
    ownerUid: req.user.uid,
    title: req.body?.title || "New chat",
    createdAt: now,
    updatedAt: now
  });
  res.json({ id: ref.key });
});

// ---- Send message: save user msg -> call Gemini -> save assistant msg
app.post("/api/sessions/:id/messages", authGuard, async (req, res) => {
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: "content required" });

  try {
    const sessRef = db.ref(`sessions/${req.params.id}`);
    const sess = (await sessRef.once("value")).val();
    if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

    const msgsRef = db.ref(`messagesBySession/${req.params.id}`);
    const now = new Date().toISOString();

    // 1) store user message
    const userMsg = { ownerUid: req.user.uid, role: "user", content, createdAt: now };
    await msgsRef.push().set(userMsg);

    // 2) call Gemini (never throw out)
    // call Gemini
    let replyText = "";
    try {
      const out = await geminiGenerate({ prompt: content });
      replyText = extractGeminiText(out.body);
    } catch (e) {
      console.error("Gemini call failed:", e);
      replyText = "Sorry—LLM is unavailable right now.";
    }


    // 3) store assistant message
    const botMsg = { ownerUid: req.user.uid, role: "assistant", content: String(replyText), createdAt: new Date().toISOString() };
    await msgsRef.push().set(botMsg);

    // 4) update session metadata
    await sessRef.update({
      updatedAt: new Date().toISOString(),
      title: (sess.title && sess.title.trim()) ? sess.title : content.slice(0, 40)
    });

    // 5) respond
    res.json({ ok: true, assistant: botMsg.content });
  } catch (err) {
    console.error("POST /sessions/:id/messages error:", err);
    res.status(500).json({ error: "server error" });
  }
});


// ---- Gemini integration ----
function stripModelsPrefix(m) { return m?.startsWith("models/") ? m.slice(7) : m; }

async function geminiGenerate({ prompt, model, forceVer }) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return { status: 500, body: JSON.stringify({ error: "GEMINI_API_KEY not set" }), ct: "application/json" };

  const base = stripModelsPrefix(model || (process.env.GEMINI_MODEL || "gemini-2.5-flash"));
  const candidates = Array.from(new Set([
    base,
    base && !base.endsWith("-001") ? `${base}-001` : base,
    "gemini-1.5-flash-001",
    "gemini-1.5-pro-001",
    "gemini-pro",
  ].filter(Boolean)));

  const versions = forceVer ? [forceVer] : ["v1", "v1beta"];

  for (const ver of versions) {
    for (const m of candidates) {
      const url = `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(KEY)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }]}],
          generationConfig: { maxOutputTokens: 256, temperature: 0.8 }
        })
      });
      const text = await r.text();
      const ct = r.headers.get("content-type") || "application/json";
      if (r.status !== 404) return { status: r.status, body: text, ct, model: m, ver };
    }
  }

  return { status: 404, body: JSON.stringify({ error: "Model not found on v1 or v1beta" }, null, 2), ct: "application/json" };
}
function extractGeminiText(raw) {
  // raw is a JSON string from the API
  try {
    const j = JSON.parse(raw);
    const parts = j?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p?.text || "").join("").trim();
    return text || raw; // fall back to raw if empty
  } catch {
    return raw; // if not JSON, just return as-is
  }
}

// ---- Send message: save user msg -> call Gemini -> save assistant msg
app.post("/api/sessions/:id/messages", authGuard, async (req, res) => {
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: "content required" });

  const sessRef = db.ref(`sessions/${req.params.id}`);
  const sess = (await sessRef.once("value")).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const now = new Date().toISOString();
  const msgsRef = db.ref(`messagesBySession/${req.params.id}`);

  // store user message
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "user", content, createdAt: now
  });

  // call Gemini
  let replyText = "";
  try {
    const out = await geminiGenerate({ prompt: content });
    // prefer parsed JSON if available
    try {
      const json = JSON.parse(out.body);
      replyText = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? out.body;
    } catch { replyText = out.body; }
  } catch (e) {
    console.error("Gemini call failed:", e);
    replyText = "Sorry—LLM is unavailable right now.";
  }

  // store assistant message
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "assistant", content: replyText, createdAt: new Date().toISOString()
  });

  // update session metadata
  await sessRef.update({
    updatedAt: new Date().toISOString(),
    title: sess.title && sess.title.trim() ? sess.title : content.slice(0, 40)
  });

  res.json({ reply: replyText });
});

// ---- Test route for Gemini
app.get("/test-hf", async (req, res) => {
  const out = await geminiGenerate({
    prompt: req.query.prompt || "Say hello from Gemini!",
    model: req.query.model,
    forceVer: req.query.ver
  });
  res.status(out.status).type(out.ct).send(out.body);
});

// ---- SPA fallback for non-API GETs without file extensions
app.use((req, res, next) => {
  if (req.method === "GET" &&
      !req.path.startsWith("/api/") &&
      !req.path.startsWith("/test-") &&
      !req.path.includes(".") &&
      req.accepts("html")) {
    return res.sendFile(path.join(clientDir, "index.html"));
  }
  next();
});
// DEBUG: list mounted routes
app.get("/__routes", (_req, res) => {
  const out = [];
  app._router?.stack?.forEach((layer) => {
    if (layer.route) {
      out.push({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      });
    }
  });
  res.json(out);
});
// ---- 404 last
app.use((_req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => {
  console.log(`Web + API running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) console.warn("⚠️  GEMINI_API_KEY is not set (affects replies).");
  if (!process.env.RTDB_URL) console.warn("⚠️  RTDB_URL not set (Firebase DB).");
});
