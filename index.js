// server/index.js — Express 5 + Firebase RTDB + Gemini + static frontend
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import admin from "firebase-admin";

// ---------- Firebase Admin ----------
const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : null;

admin.initializeApp(
  saJson
    ? { credential: admin.credential.cert(saJson), databaseURL: process.env.RTDB_URL }
    : { credential: admin.credential.applicationDefault(), databaseURL: process.env.RTDB_URL }
);

const db = admin.database();

// ---------- App ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 9188);

app.use(express.json());
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ---------- Route registry (avoid brittle app._router hacks) ----------
const ROUTES = [];
const GET  = (p, ...h) => { ROUTES.push({ method: "GET",  path: p });  return app.get(p,  ...h); };
const POST = (p, ...h) => { ROUTES.push({ method: "POST", path: p });  return app.post(p, ...h); };

// ---------- Health ----------
GET("/ping", (_req, res) => res.json({ ok: true }));

// ---------- Auth guard (Firebase ID token from client) ----------
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

// ---------- Sessions ----------
GET("/api/sessions", authGuard, async (req, res) => {
  const snap = await db
    .ref("sessions")
    .orderByChild("ownerUid")
    .equalTo(req.user.uid)
    .once("value");
  const val = snap.val() || {};
  const list = Object.entries(val)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(list);
});

POST("/api/sessions", authGuard, async (req, res) => {
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

// ---------- Messages (GET + POST) ----------
// ✅ This GET handler was missing in your deployed code (causing 404)
GET("/api/sessions/:id/messages", authGuard, async (req, res) => {
  const sess = (await db.ref(`sessions/${req.params.id}`).once("value")).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const snap = await db
    .ref(`messagesBySession/${req.params.id}`)
    .orderByChild("createdAt")
    .once("value");

  const out = [];
  snap.forEach((c) => out.push({ id: c.key, ...c.val() }));
  res.json(out);
});

// Save user -> call Gemini -> save assistant -> return reply
POST("/api/sessions/:id/messages", authGuard, async (req, res) => {
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: "content required" });

  const sessRef = db.ref(`sessions/${req.params.id}`);
  const sess = (await sessRef.once("value")).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const msgsRef = db.ref(`messagesBySession/${req.params.id}`);
  const now = new Date().toISOString();

  // 1) store user message
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "user", content, createdAt: now
  });

  // 2) call Gemini
  let replyText = "";
  try {
    // First: whatever model is configured (default 2.5-flash)
    const out1 = await geminiGenerate({ prompt: content });
    replyText = extractGeminiText(out1.body);

    // Fallback: stable 1.5 if no visible text (e.g., MAX_TOKENS consumed by "thoughts")
    if (!replyText) {
      const out2 = await geminiGenerate({ prompt: content, model: "gemini-1.5-flash-001", forceVer: "v1" });
      replyText = extractGeminiText(out2.body);
    }

    if (!replyText) replyText = "Sorry—no text came back from the model.";
  } catch (e) {
    console.error("Gemini call failed:", e);
    replyText = "Sorry—LLM is unavailable right now.";
  }

  // 3) store assistant message (TEXT ONLY)
  await msgsRef.push().set({
    ownerUid: req.user.uid, role: "assistant", content: String(replyText),
    createdAt: new Date().toISOString()
  });

  // 4) update session metadata
  await sessRef.update({
    updatedAt: new Date().toISOString(),
    title: sess.title?.trim() ? sess.title : content.slice(0, 40)
  });

  res.json({ reply: replyText });
});


// ---------- Gemini ----------
function stripModelsPrefix(m) {
  return m?.startsWith("models/") ? m.slice(7) : m;
}

function extractGeminiText(raw) {
  try {
    const j = JSON.parse(raw);

    // New Gemini format: candidates[].content.parts[].text
    let text = "";
    const parts = j?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      text = parts.map(p => (p?.text || "")).join("").trim();
    }

    // Some variants use output_text (older helpers)
    if (!text && typeof j?.output_text === "string") {
      text = j.output_text.trim();
    }

    return text; // may be "" if no visible text
  } catch {
    return "";
  }
}

async function geminiGenerate({ prompt, model, forceVer }) {
  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) {
    return { status: 500, body: JSON.stringify({ error: "GEMINI_API_KEY not set" }), ct: "application/json" };
  }

  const base = (model || process.env.GEMINI_MODEL || "gemini-2.5-flash").replace(/^models\//, "");
  // Try base, then a couple of stable fallbacks
  const models = [base, `${base}-001`, "gemini-1.5-flash-001", "gemini-1.5-pro-001", "gemini-pro"]
    .filter((v, i, a) => v && a.indexOf(v) === i);

  const versions = forceVer ? [forceVer] : ["v1", "v1beta"];

  for (const ver of versions) {
    for (const m of models) {
      const url = `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(KEY)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }]}],
          // Force plain text back; support both spellings used across releases
          generationConfig: {
            maxOutputTokens: 256,
            temperature: 0.7,
            responseMimeType: "text/plain",
            response_mime_type: "text/plain"
          }
        })
      });

      const body = await r.text();
      const ct = r.headers.get("content-type") || "application/json";

      // If not a 404, return what we got (we'll decide on text later)
      if (r.status !== 404) {
        return { status: r.status, body, ct, model: m, ver };
      }
    }
  }

  return { status: 404, body: JSON.stringify({ error: "Model not found on v1 or v1beta" }, null, 2), ct: "application/json" };
}

// ---------- Test route ----------
GET("/test-hf", async (req, res) => {
  const out = await geminiGenerate({
    prompt: req.query.prompt || "Say hello from Gemini!",
    model: req.query.model,
    forceVer: req.query.ver,
  });
  res.status(out.status).type(out.ct).send(out.body);
});

// ---------- Debug: list registered routes (reliable) ----------
GET("/__routes", (_req, res) => res.json(ROUTES));

// ---------- Static frontend (place your index.html + client.js in /server/public) ----------
const clientDir = path.resolve(__dirname, "public");
app.use(express.static(clientDir));

// ---------- SPA fallback ----------
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

// ---------- 404 last ----------
app.use((_req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => {
  console.log(`Web + API running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) console.warn("⚠️  GEMINI_API_KEY is not set (affects replies).");
  if (!process.env.RTDB_URL) console.warn("⚠️  RTDB_URL not set (Firebase DB).");
});
