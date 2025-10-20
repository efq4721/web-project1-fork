// server/index.js — Express 5 + Firebase RTDB + Gemini (stateless per turn)
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

// No-cache for static to avoid stale CSS/JS
const fs = await import("node:fs");
const CLIENT_DIR = process.env.CLIENT_DIR || null;
// Prefer $CLIENT_DIR, else ./public if it exists, else current dir
const candidateA = CLIENT_DIR ? path.resolve(CLIENT_DIR) : null;
const candidateB = path.resolve(__dirname, "public");
const candidateC = path.resolve(__dirname);
const pick = (p) => p && fs.existsSync(p) && fs.statSync(p).isDirectory();
const clientDir = pick(candidateA) ? candidateA : (pick(candidateB) ? candidateB : candidateC);
app.use((req, res, next) => {
  if (/\.(css|js|map)$/.test(req.url)) res.set("Cache-Control", "no-store");
  next();
});
app.use(express.static(clientDir, { etag: false, lastModified: false, cacheControl: false, maxAge: 0 }));

// ── Health ───────────────────────────────────────────────────────────────────
app.get("/ping", (_req, res) => res.json({ ok: true }));

// ── Auth guard ───────────────────────────────────────────────────────────────
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
  const snap = await db.ref("sessions").orderByChild("ownerUid").equalTo(req.user.uid).once("value");
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
  });
  res.json({ id: ref.key });
});

// ── Messages ─────────────────────────────────────────────────────────────────
app.get("/api/sessions/:id/messages", authGuard, async (req, res) => {
  res.set("Cache-Control", "no-store");

  const sess = (await db.ref(`sessions/${req.params.id}`).once("value")).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const snap = await db.ref(`messagesBySession/${req.params.id}`).once("value");
  const out = [];
  snap.forEach(c => { out.push({ id: c.key, ...c.val() }); });
  out.sort((a, b) => {
    const ta = a.createdAtMs != null ? a.createdAtMs : (a.createdAt ? Date.parse(a.createdAt) : 0);
    const tb = b.createdAtMs != null ? b.createdAtMs : (b.createdAt ? Date.parse(b.createdAt) : 0);
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

  // 1) save user msg
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "user", content, createdAt: nowIso, createdAtMs: nowMs
  });

  // 2) stateless Gemini call (SYSTEM_INSTRUCTION only)
  const systemText =
    (sess?.systemPrompt && String(sess.systemPrompt).trim()) ||
    (process.env.SYSTEM_INSTRUCTION || "").trim() || "";

  let replyText = "";
  try {
    replyText = await generateTextFromGemini(content, systemText);
    if (!replyText) replyText = "Sorry — no text came back from the model.";
  } catch (e) {
    console.error("Gemini error:", e);
    replyText = "Sorry — LLM is unavailable right now.";
  }

  // 3) save assistant msg
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

// ── Gemini (simple, no history reuse; at most one continuation) ──────────────
async function callGeminiOnce({ prompt, systemText, model, ver }) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return { status: 500, json: { error: "GEMINI_API_KEY not set" } };

  const url = `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(KEY)}`;

  const body = {
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    contents: [{ role: "user", parts: [{ text: prompt }]}],
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

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const txt = await r.text();
  let json;
  try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  return { status: r.status, json };
}

async function generateTextFromGemini(userPrompt, systemText) {
  const model = (process.env.GEMINI_MODEL || "gemini-2.5-pro").replace(/^models\//, "");
  for (const ver of ["v1beta", "v1"]) {
    // first pass
    const a = await callGeminiOnce({ prompt: userPrompt, systemText, model, ver });
    const candA = a.json?.candidates?.[0];
    const chunkA = (candA?.content?.parts || []).map(p => p?.text || "").join("").trim();
    const finishA = candA?.finishReason || candA?.finish_reason || "";
    let acc = chunkA;

    if (finishA === "MAX_TOKENS") {
      // one continuation only; prevents topic drift/restarts
      const b = await callGeminiOnce({ prompt: "Continue.", systemText, model, ver });
      const candB = b.json?.candidates?.[0];
      const chunkB = (candB?.content?.parts || []).map(p => p?.text || "").join("").trim();
      if (chunkB) acc = (acc ? acc + "\n\n" : "") + chunkB;
    }

    if (acc && acc.trim()) return acc.trim();
  }
  return "";
}

// ── SPA fallback & 404 ───────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (
    req.method === "GET" &&
    !req.path.startsWith("/api/") &&
    !req.path.includes(".") &&
    req.accepts("html")
  ) {
    return res.sendFile(path.join(clientDir, "index.html"));
  }
  next();
});
app.use((_req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => {
  console.log(`Web + API running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) console.warn("⚠️  GEMINI_API_KEY missing");
  if (!process.env.RTDB_URL) console.warn("⚠️  RTDB_URL missing");
});
