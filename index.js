// server/index.js — Express 5 + Firebase RTDB + Gemini 2.5 w/ FGC steering, typo fix, robust fallbacks
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
// App
// ──────────────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 9188);

app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Route registry for /__routes
const ROUTES = [];
const GET  = (p, ...h) => { ROUTES.push({ method: "GET",  path: p });  return app.get(p,  ...h); };
const POST = (p, ...h) => { ROUTES.push({ method: "POST", path: p });  return app.post(p, ...h); };

// ──────────────────────────────────────────────────────────────────────────────
// Health
// ──────────────────────────────────────────────────────────────────────────────
GET("/ping", (_req, res) => res.json({ ok: true }));

// ──────────────────────────────────────────────────────────────────────────────
// Auth guard (Firebase ID token in Authorization: Bearer <token>)
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
// Helpers: FGC prompt normalizer & system instruction
// ──────────────────────────────────────────────────────────────────────────────
const DEFAULT_SYSTEM = (process.env.SYSTEM_INSTRUCTION || `
You are an assistant focused on fighting games (FGC). Prioritize 2D/3D titles like Street Fighter 6, Guilty Gear Strive, Tekken 8, Mortal Kombat 1, Granblue Fantasy Versus, Melty Blood, Skullgirls, Dragon Ball FighterZ, and 2XKO.
Goals: explain mechanics (frame data, hitbox/hurtbox, advantage, links/cancels, okizeme, neutral/footsies), matchups, gameplans, training-mode drills, controller setup, online play (rollback), tournament basics.
Style: plain text only; concise but hype; use bullet points when listing tips; include concrete inputs (e.g., 236P) when helpful.
Typos: silently correct obvious misspellings (e.g., "Gpku"→"Goku", "Shoryken"→"Shoryuken").
If unclear or ambiguous, assume FGC context and answer with the most likely FGC meaning. Do NOT return empty output; always reply with at least one sentence.`).trim();

function normalizeFGCPrompt(text) {
  const t = String(text || "").trim();

  // Heuristic expansions for short/ambiguous prompts common in FGC chats
  const low = t.toLowerCase();

  if (low === "sf6" || low === "what is sf6?" || low === "what is sf6") {
    return "In the context of fighting games, what is Street Fighter 6 (SF6)? Give a short overview.";
  }

  if (low === "what is plus?" || low === "plus?" || low === "plus") {
    return "In fighting games, what does being + (plus on block or hit) mean? Explain frame advantage briefly with an example.";
  }

  if (low === "what is minus?" || low === "minus?" || low === "minus") {
    return "In fighting games, what does being − (minus on block or hit) mean? Explain frame disadvantage briefly with an example.";
  }

  if (low === "who are you?" || low === "what can you do?" || low === "what are you?") {
    return "Briefly introduce yourself as a fighting game assistant and list 3 useful things you can help with.";
  }

  // If the user mentions a well-known character or game but is vague, add FGC bias
  const keywords = ["goku", "ryu", "ken", "akuma", "jin", "kazuya", "sol", "ky", "johnny", "spider-man", "spiderman", "dragon ball", "dbfz", "tekken", "street fighter", "sf6", "ggst", "mk1", "2xko"];
  for (const k of keywords) {
    if (low.includes(k)) {
      return `In fighting game context, ${t}`;
    }
  }

  // Default: add FGC framing if the prompt is extremely short (<= 4 words) or ambiguous
  const wordCount = t.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 4) {
    return `In fighting game context, ${t}`;
  }

  return t;
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
    .sort((a, b) => {
      const ta = (a.updatedAt && Date.parse(a.updatedAt)) || (a.createdAt && Date.parse(a.createdAt)) || 0;
      const tb = (b.updatedAt && Date.parse(b.updatedAt)) || (b.createdAt && Date.parse(b.createdAt)) || 0;
      return tb - ta; // newest first
    });
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
    // optional: allow per-session system prompt later if you want
    // systemPrompt: req.body?.systemPrompt || null
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

  const snap = await db.ref(`messagesBySession/${req.params.id}`).once("value");
  const out = [];
  // IMPORTANT: use braces so callback doesn't return a truthy value
  snap.forEach((c) => { out.push({ id: c.key, ...c.val() }); });

  // sort chronologically by ms, fallback to parsed ISO
  out.sort((a, b) => {
    const ta = (a.createdAtMs != null) ? a.createdAtMs :
               ((a.createdAt ? Date.parse(a.createdAt) : 0) || 0);
    const tb = (b.createdAtMs != null) ? b.createdAtMs :
               ((b.createdAt ? Date.parse(b.createdAt) : 0) || 0);
    return ta - tb;
  });

  res.json(out);
});

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

  // 2) build steering + normalized prompt
  const systemText =
    (sess && sess.systemPrompt) ? String(sess.systemPrompt) :
    (process.env.SYSTEM_INSTRUCTION ? String(process.env.SYSTEM_INSTRUCTION) : DEFAULT_SYSTEM);

  const normalized = normalizeFGCPrompt(content);

  // 3) call Gemini (2.5 first; typo-correct pass; then 1.5 fallback)
  let replyText = "";
  try {
    replyText = await generateTextFromGemini(normalized, systemText);
    if (!replyText) replyText = "I didn’t catch that—could you rephrase?";
  } catch (e) {
    console.error("Gemini call failed:", e);
    replyText = "I didn’t catch that—could you rephrase?";
  }

  // 4) store assistant message (never empty)
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "assistant", content: String(replyText),
    createdAt: new Date().toISOString(), createdAtMs: Date.now()
  });

  // 5) session metadata
  await sessRef.update({
    updatedAt: new Date().toISOString(),
    title: (sess.title && String(sess.title).trim()) ? sess.title : content.slice(0, 40)
  });

  res.json({ reply: replyText });
});

// ──────────────────────────────────────────────────────────────────────────────
function extractGeminiText(raw) {
  if (typeof raw === "string" && raw.length && raw[0] !== "{" && raw[0] !== "[") {
    return raw.trim(); // already plain text
  }
  try {
    const j = JSON.parse(raw);
    const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    if (Array.isArray(parts)) {
      let txt = "";
      for (const p of parts) {
        if (p && typeof p.text === "string") txt += p.text;
      }
      txt = txt.trim();
      if (txt) return txt;
    }
    if (j && typeof j.output_text === "string" && j.output_text.trim()) {
      return j.output_text.trim();
    }
    return "";
  } catch {
    return (raw || "").toString().trim();
  }
}

// Lightweight typo-corrector using a very reliable text model
async function autocorrectPrompt(original, systemText) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return original;

  const model = "gemini-1.5-flash-001";
  const ver = "v1";
  const url = `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(KEY)}`;

  const body = {
    systemInstruction: {
      parts: [{ text:
`You correct obvious typos/misspellings in short questions.
Return ONLY the corrected question as plain text. No quotes, no extra words.
If no correction is needed, output the input unchanged.` }]
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
  } catch (_) {}
  return original;
}

async function callGemini({ prompt, model, ver, systemText }) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) {
    return { status: 500, body: JSON.stringify({ error: "GEMINI_API_KEY not set" }), ct: "application/json" };
  }

  const url = `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(KEY)}`;

  const body = {
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    contents: [{ role: "user", parts: [{ text: prompt }]}],
    generationConfig: {
      maxOutputTokens: 180,
      temperature: 0.5,
      topK: 64,
      topP: 0.95,
      responseMimeType: "text/plain",
      response_mime_type: "text/plain"
    },
    // keep permissive to avoid benign blanks
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
    ]
  };

  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  const ct = r.headers.get("content-type") || "application/json";
  return { status: r.status, body: text, ct };
}

async function generateTextFromGemini(prompt, systemText) {
  // Default to your stable 2.5; allow env override
  const base = (process.env.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");

  // 1) Try 2.5 straight
  {
    const out = await callGemini({ prompt, ver: "v1beta", model: base, systemText });
    const t   = (out.ct && out.ct.includes("text/plain")) ? (out.body || "").trim() : extractGeminiText(out.body);
    if (t) return t;
  }

  // 2) Auto-correct then re-ask 2.5
  {
    const fixed = await autocorrectPrompt(prompt, systemText);
    if (fixed && fixed !== prompt) {
      const out2 = await callGemini({ prompt: fixed, ver: "v1beta", model: base, systemText });
      const t2   = (out2.ct && out2.ct.includes("text/plain")) ? (out2.body || "").trim() : extractGeminiText(out2.body);
      if (t2) return t2;
    }
  }

  // 3) Final: reliable 1.5 fallbacks
  for (const m of ["gemini-1.5-flash-001", "gemini-1.5-pro-001"]) {
    const out3 = await callGemini({ prompt, ver: "v1", model: m, systemText });
    const t3   = (out3.ct && out3.ct.includes("text/plain")) ? (out3.body || "").trim() : extractGeminiText(out3.body);
    if (t3) return t3;
  }

  return "";
}

// ──────────────────────────────────────────────────────────────────────────────
// Test + routes debug
// ──────────────────────────────────────────────────────────────────────────────
GET("/test-hf", async (req, res) => {
  const systemText = DEFAULT_SYSTEM;
  const prompt = normalizeFGCPrompt(req.query.prompt || "Say hello from Gemini!");
  const text = await generateTextFromGemini(prompt, systemText);
  if (!text) return res.status(502).json({ error: "No text from Gemini" });
  res.type("text/plain").send(text);
});

GET("/__routes", (_req, res) => res.json(ROUTES));

// ──────────────────────────────────────────────────────────────────────────────
// Static frontend (index.html + client.js in /server/public)
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
