// server/index.js — Express 5 + Firebase RTDB + Gemini 2.5 + static frontend (ESM)
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
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 9188);

// Basic logging + JSON
app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Route registry (for /__routes)
const ROUTES = [];
const GET  = (p, ...h) => { ROUTES.push({ method: "GET",  path: p });  return app.get(p,  ...h); };
const POST = (p, ...h) => { ROUTES.push({ method: "POST", path: p });  return app.post(p, ...h); };

// Small helpers
const noStore = (res) => res.set("Cache-Control", "no-store");
const tsOf = (m) => {
  if (m && typeof m.createdAtMs === "number") return m.createdAtMs;
  const d = m && m.createdAt ? Date.parse(m.createdAt) : 0;
  return Number.isFinite(d) ? d : 0;
};

// ──────────────────────────────────────────────────────────────────────────────
// Health
// ──────────────────────────────────────────────────────────────────────────────
GET("/ping", (_req, res) => res.json({ ok: true }));

// ──────────────────────────────────────────────────────────────────────────────
// Auth guard (expects Firebase ID token in Authorization: Bearer <token>)
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
  noStore(res);
  const snap = await db.ref("sessions")
    .orderByChild("ownerUid").equalTo(req.user.uid).once("value");
  const val = snap.val() || {};
  const list = Object.entries(val).map(([id, v]) => ({ id, ...v }));
  list.sort((a, b) => {
    const ta = (a.updatedAt ? Date.parse(a.updatedAt) : 0) || (a.createdAt ? Date.parse(a.createdAt) : 0) || 0;
    const tb = (b.updatedAt ? Date.parse(b.updatedAt) : 0) || (b.createdAt ? Date.parse(b.createdAt) : 0) || 0;
    return tb - ta; // newest first
  });
  res.json(list);
});

POST("/api/sessions", authGuard, async (req, res) => {
  noStore(res);
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

// ──────────────────────────────────────────────────────────────────────────────
// Messages (GET + POST)
// ──────────────────────────────────────────────────────────────────────────────
GET("/api/sessions/:id/messages", authGuard, async (req, res) => {
  noStore(res);

  const sess = (await db.ref(`sessions/${req.params.id}`).once("value")).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const snap = await db.ref(`messagesBySession/${req.params.id}`).once("value");

  const out = [];
  // IMPORTANT: use braces so callback returns undefined (continues iteration)
  snap.forEach((c) => { out.push({ id: c.key, ...c.val() }); });

  out.sort((a, b) => tsOf(a) - tsOf(b)); // chronological
  res.json(out);
});

POST("/api/sessions/:id/messages", authGuard, async (req, res) => {
  noStore(res);
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

  // Pick a system instruction: per-session > env > default (null)
  const systemText =
    (sess.systemPrompt && String(sess.systemPrompt)) ||
    process.env.SYSTEM_INSTRUCTION ||
    null;

  // 2) call Gemini
  let replyText = "";
  try {
    replyText = await generateTextFromGemini(content, systemText);
  } catch (e) {
    console.error("Gemini call failed:", e);
    replyText = "";
  }

  // HARD GUARD: never store empty assistant messages
  replyText = (replyText || "").trim();
  if (!replyText) replyText = "I didn’t catch that—could you rephrase?";

  // 3) store assistant message
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "assistant", content: replyText,
    createdAt: new Date().toISOString(), createdAtMs: Date.now()
  });

  // 4) bump session
  await sessRef.update({
    updatedAt: new Date().toISOString(),
    title: (sess.title && sess.title.trim()) ? sess.title : content.slice(0, 40)
  });

  res.json({ reply: replyText });
});

// ──────────────────────────────────────────────────────────────────────────────
// Gemini helpers — default to 2.5 Flash; force visible text; smart fallbacks
// ──────────────────────────────────────────────────────────────────────────────
function extractGeminiText(raw) {
  if (typeof raw === "string" && raw.length && raw[0] !== "{" && raw[0] !== "[") {
    return raw.trim(); // already plain text
  }
  try {
    const j = JSON.parse(raw);
    const parts = j?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const txt = parts.map(p => p?.text || "").join("").trim();
      if (txt) return txt;
    }
    if (typeof j?.output_text === "string" && j.output_text.trim()) {
      return j.output_text.trim();
    }
    return "";
  } catch {
    return (raw || "").toString().trim();
  }
}

async function callGemini({ prompt, model, ver, systemText }) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) {
    return { status: 500, body: JSON.stringify({ error: "GEMINI_API_KEY not set" }), ct: "application/json" };
  }

  const url = `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(KEY)}`;

  // Strong nudge for visible, short text; relax safety so benign prompts don't get blanked
  const body = {
    systemInstruction: systemText
      ? { parts: [{ text: systemText }] }
      : { parts: [{ text:
`Answer in plain text only (no JSON, no code fences). Keep replies short and direct.
Silently correct obvious typos in names and questions. If input is unclear, ask one short clarifying question.` }] },
    contents: [{ role: "user", parts: [{ text: prompt }]}],
    generationConfig: {
      maxOutputTokens: 160,
      temperature: 0.5,
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

  const text = await r.text();
  const ct = r.headers.get("content-type") || "application/json";
  return { status: r.status, body: text, ct };
}

// Optional: typo autocorrect pass (fast, reliable)
async function autocorrectPrompt(original) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return original;

  const model = "gemini-1.5-flash-001";
  const ver = "v1";
  const url = `https://generativelanguage.googleapis.com/${ver}/models/${model}:generateContent?key=${encodeURIComponent(KEY)}`;

  const body = {
    systemInstruction: {
      parts: [{ text:
`You correct obvious typos/misspellings in short questions (e.g., "Gpku"->"Goku").
Return ONLY the corrected question as plain text. If no correction is needed, return the input unchanged.` }]
    },
    contents: [{ role: "user", parts: [{ text: original }]}],
    generationConfig: {
      maxOutputTokens: 32,
      temperature: 0,
      responseMimeType: "text/plain",
      response_mime_type: "text/plain"
    }
  };

  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = (await r.text()).trim();
    if (r.ok && out) return out;
  } catch (_e) {}
  return original;
}

async function generateTextFromGemini(prompt, systemText) {
  // Default to your stable 2.5 Flash; allow env override like GEMINI_MODEL=models/gemini-2.5-flash
  const base = (process.env.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");

  // Try 2.5 first (v1beta)
  {
    const out = await callGemini({ prompt, ver: "v1beta", model: base, systemText });
    const t   = (out.ct.includes("text/plain") ? (out.body || "").trim() : extractGeminiText(out.body));
    if (t) return t;
  }

  // If 2.5 gave nothing, typo-correct then re-ask 2.5
  {
    const fixed = await autocorrectPrompt(prompt);
    if (fixed && fixed !== prompt) {
      const out2 = await callGemini({ prompt: fixed, ver: "v1beta", model: base, systemText });
      const t2   = (out2.ct.includes("text/plain") ? (out2.body || "").trim() : extractGeminiText(out2.body));
      if (t2) return t2;
    }
  }

  // Final fallbacks to stable 1.5 models (v1)
  for (const m of ["gemini-1.5-flash-001", "gemini-1.5-pro-001"]) {
    const out = await callGemini({ prompt, ver: "v1", model: m, systemText });
    const t   = (out.ct.includes("text/plain") ? (out.body || "").trim() : extractGeminiText(out.body));
    if (t) return t;
  }

  // Last-ditch deterministic nudge so caller can show something nicer
  return "";
}

// ──────────────────────────────────────────────────────────────────────────────
// Test + routes debug
// ──────────────────────────────────────────────────────────────────────────────
GET("/test-hf", async (req, res) => {
  const sys = process.env.SYSTEM_INSTRUCTION || null;
  const text = await generateTextFromGemini(req.query.prompt || "Say hello from Gemini!", sys);
  if (!text) return res.status(502).json({ error: "No text from Gemini" });
  res.type("text/plain").send(text);
});
GET("/__routes", (_req, res) => res.json(ROUTES));

// ──────────────────────────────────────────────────────────────────────────────
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
