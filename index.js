// server/index.js
// Run with Node 18+ (fetch available) or install node-fetch if you prefer.
// If you use this file as-is, ensure package.json has: { "type": "module" }

import express from "express";
import cors from "cors";
import admin from "firebase-admin";

// If you prefer node-fetch over global fetch on Node <18, uncomment:
// import fetch from "node-fetch";

const HF_MODEL = "microsoft/Phi-3-mini-4k-instruct";

/* ---------------------- Firebase Admin (env-based) ---------------------- */
const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : null;

if (!process.env.RTDB_URL) {
  console.warn(
    "[WARN] RTDB_URL is not set. Realtime Database calls will fail until it is configured."
  );
}

admin.initializeApp(
  saJson
    ? { credential: admin.credential.cert(saJson), databaseURL: process.env.RTDB_URL }
    : { credential: admin.credential.applicationDefault(), databaseURL: process.env.RTDB_URL }
);

const db = admin.database();

/* ------------------------------- Express -------------------------------- */
const app = express();

/* --------------------------------- CORS --------------------------------- */
const allowed = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsMw = cors({
  origin: (origin, cb) => cb(null, !origin || allowed.length === 0 || allowed.includes(origin)),
  credentials: true,
});
app.use(corsMw);

// Handle all preflight (OPTIONS) requests early
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

// Normalize any // in the path to / (Express 5/path-to-regexp is strict)
app.use((req, _res, next) => {
  const orig = req.url;
  req.url = req.url.replace(/\/{2,}/g, "/");
  if (orig !== req.url) console.warn("normalized path:", orig, "->", req.url);
  next();
});

/* ------------------------------ Health/Basic ----------------------------- */
app.get("/", (_req, res) => res.send("API is running"));
app.get("/ping", (_req, res) => res.json({ status: "ok" }));

/* -------------------------- Hugging Face test --------------------------- */
app.get("/test-hf", async (_req, res) => {
  if (!process.env.HUGGINGFACE_API_KEY) {
    return res.status(500).json({ error: "HUGGINGFACE_API_KEY not set" });
  }

  try {
    const resp = await fetch(
      `https://api-inference.huggingface.co/models/${encodeURIComponent(HF_MODEL)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: "Say hello from Hugging Face!" }),
      }
    );

    // Return raw text (HF can stream or send varied shapes)
    const text = await resp.text();
    res.type("application/json").send(text);
  } catch (e) {
    console.error("HF error:", e);
    res.status(500).json({ error: "HF request failed", detail: String(e) });
  }
});

/* --------------------------------- Auth --------------------------------- */
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

/* ------------------------------- API: Chat ------------------------------- */
// List sessions for user
app.get("/api/sessions", authGuard, async (req, res) => {
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

// Create a new session
app.post("/api/sessions", authGuard, async (req, res) => {
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

// Get messages in a session
app.get("/api/sessions/:id/messages", authGuard, async (req, res) => {
  const sess = (await db.ref(`sessions/${req.params.id}`).once("value")).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const snap = await db
    .ref(`messagesBySession/${req.params.id}`)
    .orderByChild("createdAt")
    .once("value");

  const msgs = [];
  snap.forEach((child) => msgs.push({ id: child.key, ...child.val() }));
  res.json(msgs);
});

// Add a message (and simple echo reply)
app.post("/api/sessions/:id/messages", authGuard, async (req, res) => {
  const { content } = req.body || {};
  if (!content) return res.status(400).json({ error: "content required" });

  const sessRef = db.ref(`sessions/${req.params.id}`);
  const sess = (await sessRef.once("value")).val();
  if (!sess || sess.ownerUid !== req.user.uid) return res.sendStatus(403);

  const now = new Date().toISOString();

  await db
    .ref(`messagesBySession/${req.params.id}`)
    .push()
    .set({ ownerUid: req.user.uid, role: "user", content, createdAt: now });

  const reply = `You said: ${content}`;

  await db
    .ref(`messagesBySession/${req.params.id}`)
    .push()
    .set({
      ownerUid: req.user.uid,
      role: "assistant",
      content: reply,
      createdAt: new Date().toISOString(),
    });

  await sessRef.update({
    updatedAt: new Date().toISOString(),
    title: sess.title || content.slice(0, 40),
  });

  res.json({ reply });
});

/* ------------------------------ Debug/404 ------------------------------- */
// Optional: list routes when DEBUG_ROUTES=1
if (process.env.DEBUG_ROUTES === "1") {
  const listRoutes = (appOrRouter, prefix = "") => {
    const out = [];
    appOrRouter._router?.stack?.forEach((m) => {
      if (m.route) {
        const methods = Object.keys(m.route.methods)
          .map((x) => x.toUpperCase())
          .join(",");
        out.push(`${methods.padEnd(8)} ${prefix}${m.route.path}`);
      } else if (m.name === "router" && m.handle?.stack) {
        m.handle.stack.forEach((h) => {
          if (h.route) {
            const methods = Object.keys(h.route.methods)
              .map((x) => x.toUpperCase())
              .join(",");
            out.push(`${methods.padEnd(8)} ${prefix}${h.route.path}`);
          }
        });
      }
    });
    console.log("Registered routes:\n" + out.join("\n"));
  };
  // Delay until after all routes mounted
  setTimeout(() => listRoutes(app), 0);
}

// 404 handler (keep last, before error handler)
app.use((req, res) => {
  res.status(404).json({ error: "Not Found", path: req.originalUrl });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

/* --------------------------------- Boot --------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
