// server/index.js — Express 5 + Firebase RTDB + Gemini + static frontend
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import admin from "firebase-admin";

// ──────────────────────────────────────────────────────────────────────────────
// Firebase Admin
// ──────────────────────────────────────────────────────────────────────────────
const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : null;

admin.initializeApp(
  saJson
    ? { credential: admin.credential.cert(saJson), databaseURL: process.env.RTDB_URL }
    : { credential: admin.credential.applicationDefault(), databaseURL: process.env.RTDB_URL }
);

const db = admin.database();

// ──────────────────────────────────────────────────────────────────────────────
// App bootstrap
// ──────────────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 9188);

app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ──────────────────────────────────────────────────────────────────────────────
// Route helpers + registry (reliable; avoids brittle app._router hacks)
// ──────────────────────────────────────────────────────────────────────────────
const ROUTES = [];
const GET  = (p, ...h) => { ROUTES.push({ method: "GET",  path: p });  return app.get(p,  ...h); };
const POST = (p, ...h) => { ROUTES.push({ method: "POST", path: p });  return app.post(p, ...h); };

// ──────────────────────────────────────────────────────────────────────────────
GET("/ping", (_req, res) => res.json({ ok: true }));

// ──────────────────────────────────────────────────────────────────────────────
// Auth guard (expects Firebase ID token from client in Authorization: Bearer …)
// ──────────────────────────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────────────────────
// Sessions
// ──────────────────────────────────────────────────────────────────────────────
GET("/api/sessions", authGuard, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const snap = await db
    .ref("sessions")
    .orderByChild("ownerUid")
    .equalTo(req.user.uid)
    .once("value");
  const val = snap.val() || {};
  const list = Object.entries(val)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  res.json(list);
});

POST("/api/sessions", authGuard, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const now = new Date().toISOString();
  const ref = db.ref("sessions").push();
  await ref.set({
    ownerUid: req.user.uid,
    title: req.body?.title || "New chat",
    createdAt: now,
    updatedAt: now,
  });
  res.json({ id: ref.key });
});

// ──────────────────────────────────────────────────────────────────────────────
// Messages (GET + POST)
// ──────────────────────────────────────────────────────────────────────────────
GET("/api/sessions/:id/messages", authGuard, async (req, res) => {
  res.set("Cache-Control", "no-store");

  const sess = (await db.ref(`sessions/${req.params.id}`).once("value")).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const snap = await db
    .ref(`messagesBySession/${req.params.id}`)
    .once("value");

  const out = [];
  snap.forEach((c) => out.push({ id: c.key, ...c.val() }));

  // Sort robustly even if some rows lack createdAtMs (handle old data)
  out.sort((a, b) => {
    const aa = a.createdAtMs ?? Date.parse(a.createdAt || 0) || 0;
    const bb = b.createdAtMs ?? Date.parse(b.createdAt || 0) || 0;
    return aa - bb; // chronological
  });

  res.json(out);
});

// Save user -> call Gemini -> save assistant -> return reply
POST("/api/sessions/:id/messages", authGuard, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: "content required" });

  const sessRef = db.ref(`sessions/${req.params.id}`);
  const sess = (await sessRef.once("value")).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const msgsRef = db.ref(`messagesBySession/${req.params.id}`);
  const nowIso = new Date().toISOString();
  const nowMs  = Date.now();

  // 1) store user message
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "user", content, createdAt: nowIso, createdAtMs: nowMs
  });

  // 2) call Gemini (prefer stable text output; fall back until text is found)
  let replyText = "";
  try {
    replyText = await generateTextFromGemini(content);
    if (!replyText) replyText = "Sorry—no text came back from the model.";
  } catch (e) {
    console.error("Gemini call failed:", e);
    replyText = "Sorry—LLM is unavailable right now.";
  }

  // 3) store assistant message (TEXT ONLY)
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "assistant", content: String(replyText),
    createdAt: new Date().toISOString(), createdAtMs: Date.now()
  });

  // 4) update session metadata
  await sessRef.update({
    updatedAt: new Date().toISOString(),
    title: sess.title?.trim() ? sess.title : content.slice(0, 40)
  });

  res.json({ reply: replyText });
});

// ──────────────────────────────────────────────────────────────────────────────
// Gemini helpers — prefer stable v1 models that return plain text
// ──────────────────────────────────────────────────────────────────────────────
function extractGeminiText(raw) {
  // If it's already plain text, just trim and return
  if (typeof raw === "string" && (raw[0] !== "{" && raw[0] !== "[")) {
    return raw.trim();
  }
  try {
    const j = JSON.parse(raw);

    // v1 generateContent typical shape
    const parts = j?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const txt = parts.map(p => p?.text || "").join("").trim();
      if (txt) return txt;
    }

    // Some responses expose a convenience field
    if (typeof j?.output_text === "string" && j.output_text.trim()) {
      return j.output_text.trim();
    }

    // Nothing usable
    return "";
  } catch {
    // raw wasn’t JSON → treat as text
    return (raw || "").toString().trim();
  }
}

async function callGemini({ prompt, model, ver }) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) {
    return { status: 500, body: JSON.stringify({ error: "GEMINI_API_KEY not set" }), ct: "application/json" };
  }
  const url = `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(KEY)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        maxOutputTokens: 256,
        temperature: 0.7,
        // Force visible text instead of hidden "thoughts"
        responseMimeType: "text/plain",
        response_mime_type: "text/plain"
      }
    })
  });
  const body = await r.text();
  const ct = r.headers.get("content-type") || "application/json";
  return { status: r.status, body, ct };
}

async function generateTextFromGemini(prompt) {
  // Prefer stable text-first models; only try 2.x if needed
  const DEFAULT = (process.env.GEMINI_MODEL || "").replace(/^models\//, "") || "gemini-1.5-flash-001";

  const attempts = [
    { ver: "v1",     model: DEFAULT },
    { ver: "v1",     model: "gemini-1.5-pro-001" },
    { ver: "v1",     model: "gemini-pro" },
    { ver: "v1beta", model: DEFAULT },
    { ver: "v1beta", model: "gemini-2.5-flash" } // last resort
  ];

  for (const a of attempts) {
    const out = await callGemini({ prompt, ...a });
    if (out.status === 404) continue;
    const text = extractGeminiText(out.body);
    if (text) return text;
  }
  return "";
}

// ──────────────────────────────────────────────────────────────────────────────
// Test route (manual ping of Gemini)
// ──────────────────────────────────────────────────────────────────────────────
GET("/test-hf", async (req, res) => {
  const text = await generateTextFromGemini(req.query.prompt || "Say hello from Gemini!");
  if (!text) return res.status(502).json({ error: "No text from Gemini" });
  res.type("text/plain").send(text);
});

// Debug: list registered routes
GET("/__routes", (_req, res) => res.json(ROUTES));

// ──────────────────────────────────────────────────────────────────────────────
// Static frontend  (put index.html + client.js in /server/public)
// ──────────────────────────────────────────────────────────────────────────────
const clientDir = path.resolve(__dirname, "public");
app.use(express.static(clientDir));

// SPA fallback for non-API GETs without file extensions
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
