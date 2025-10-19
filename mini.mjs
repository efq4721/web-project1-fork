// mini.mjs — minimal, working server (Node 18+; built-in fetch)
import express from "express";
const app = express();

// tiny logger so you can see each hit
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// health
app.get("/ping", (_req, res) => res.json({ ok: true }));

// >>> THIS is the real /test-hf route <<<
app.get("/test-hf", async (_req, res) => {
  const key = process.env.HUGGINGFACE_API_KEY;
  if (!key) return res.status(500).json({ error: "HUGGINGFACE_API_KEY not set" });
  try {
    const r = await fetch(
      "https://api-inference.huggingface.co/models/microsoft/Phi-3-mini-4k-instruct",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ inputs: "Say hello from Hugging Face!" }),
      }
    );
    const text = await r.text();               // HF may return warmup JSON first call
    res.type("application/json").send(text);   // send exactly what HF returns
  } catch (e) {
    console.error("HF error:", e);
    res.status(500).json({ error: "HF request failed", detail: String(e) });
  }
});

// optional: show ACTUAL registered routes
app.get("/__routes", (_req, res) => {
  const out = [];
  (app._router?.stack || []).forEach(l => {
    if (l.route) out.push({ path: l.route.path, methods: Object.keys(l.route.methods) });
  });
  res.json(out);
});

// 404 LAST
app.use((_req, res) => res.status(404).send("Not Found"));

app.listen(9099, () => console.log("MINI listening on 9099"));
