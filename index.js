// server/index.js — frontend + API (Express 5, Node 18+ ESM)
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT || 9188);

// ---- Gemini config (optional test route)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const DEFAULT_MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-2.5-flash-001",
  "gemini-2.5-flash",
  "gemini-1.5-flash-001",
  "gemini-1.5-pro-001",
  "gemini-pro",
].filter(Boolean);

// ---- middleware
app.use(express.json());
app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`); next(); });

// ---- serve frontend (put index.html + client.js in ../client)
const clientDir = path.resolve(__dirname, "public");
app.use(express.static(clientDir));

// ---- health
app.get("/ping", (_req, res) => res.json({ ok: true }));

// ---- ultra-simple "auth" for dev (no Firebase needed here)
function devAuth(req, _res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  req.user = { uid: token ? `u_${token.slice(-8)}` : "anon" }; // stable but fake uid
  next();
}

// ---- in-memory store (per-process)
const sessionsByUser = new Map();             // uid -> Map(sessionId -> session)
const messagesBySession = new Map();          // sessionId -> [{role, content, createdAt}]

function getUserSessions(uid) {
  if (!sessionsByUser.has(uid)) sessionsByUser.set(uid, new Map());
  return sessionsByUser.get(uid);
}

// ---- chat API (what your UI calls)
app.get("/api/sessions", devAuth, (req, res) => {
  const map = getUserSessions(req.user.uid);
  const list = Array.from(map.entries()).map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  res.json(list);
});

app.post("/api/sessions", devAuth, (req, res) => {
  const now = new Date().toISOString();
  const id  = crypto.randomUUID();
  const map = getUserSessions(req.user.uid);
  map.set(id, {
    ownerUid: req.user.uid,
    title: req.body?.title || "New chat",
    createdAt: now,
    updatedAt: now,
  });
  messagesBySession.set(id, []);
  res.json({ id });
});

app.get("/api/sessions/:id/messages", devAuth, (req, res) => {
  const sess = getUserSessions(req.user.uid).get(req.params.id);
  if (!sess) return res.json([]); // not found for this user -> empty
  res.json(messagesBySession.get(req.params.id) || []);
});

app.post("/api/sessions/:id/messages", devAuth, async (req, res) => {
  const content = (req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: "content required" });

  const sessMap = getUserSessions(req.user.uid);
  const sess = sessMap.get(req.params.id);
  if (!sess) return res.status(404).json({ error: "session not found" });

  const now = new Date().toISOString();
  const bucket = messagesBySession.get(req.params.id) || [];
  bucket.push({ role: "user", content, createdAt: now });
  messagesBySession.set(req.params.id, bucket);

  // Minimal assistant: echo. (Swap with Gemini call if you want)
  const reply = `You said: ${content}`;
  bucket.push({ role: "assistant", content: reply, createdAt: new Date().toISOString() });

  sessMap.set(req.params.id, { ...sess, updatedAt: new Date().toISOString(), title: sess.title || content.slice(0, 40) });
  res.json({ reply });
});

// ---- optional: /test-hf now points to Gemini to sanity-check your key
function stripModelsPrefix(m) { return m?.startsWith("models/") ? m.slice(7) : m; }
async function geminiGenerate({ prompt, model, forceVer }) {
  if (!GEMINI_API_KEY) return { status: 500, body: JSON.stringify({ error: "GEMINI_API_KEY not set" }), ct: "application/json" };

  const base = stripModelsPrefix(model || "");
  const candidates = Array.from(new Set([
    base,
    base && !base.endsWith("-001") ? `${base}-001` : base,
    ...DEFAULT_MODELS,
  ].filter(Boolean)));
  const versions = forceVer ? [forceVer] : ["v1", "v1beta"];

  for (const ver of versions) {
    for (const m of candidates) {
      const url = `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }]}],
          generationConfig: { maxOutputTokens: 60 },
        }),
      });
      const text = await r.text();
      if (r.status !== 404) return { status: r.status, body: text, ct: r.headers.get("content-type") || "application/json" };
    }
  }
  return { status: 404, body: JSON.stringify({ error: "Model not found on v1 or v1beta" }, null, 2), ct: "application/json" };
}

app.get("/test-hf", async (req, res) => {
  const out = await geminiGenerate({
    prompt: req.query.prompt || "Say hello from Gemini!",
    model: req.query.model,
    forceVer: req.query.ver,
  });
  res.status(out.status).type(out.ct).send(out.body);
});

// ---- SPA fallback for non-API GETs without file extensions
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api/") && !req.path.startsWith("/test-") && !req.path.includes(".") && req.accepts("html")) {
    return res.sendFile(path.join(clientDir, "index.html"));
  }
  next();
});

// ---- 404 last
app.use((_req, res) => res.status(404).send("Not Found"));

app.listen(PORT, () => {
  console.log(`Web + API running at http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) console.warn("⚠️  GEMINI_API_KEY not set (only affects /test-hf).");
});
