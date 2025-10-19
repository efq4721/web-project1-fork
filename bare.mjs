// bare.mjs — Gemini (AI Studio) with version fallback + /list-models
// Node 18+ (built-in fetch). Binds to 127.0.0.1:9188

import http from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 9188);

// ENV: set GEMINI_API_KEY (AIza...)
// Optional: GEMINI_MODEL (default order tried below), GEMINI_API_VER to force "v1" or "v1beta"
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const DEFAULT_MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-1.5-flash-latest",
  "gemini-1.5-pro-latest",
  "gemini-pro"
].filter(Boolean);

// Helpers
function send(res, code, body, ct = "application/json") {
  res.statusCode = code;
  res.setHeader("Content-Type", ct);
  res.setHeader("Cache-Control", "no-store");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function stripPrefix(m) { return m?.startsWith("models/") ? m.slice(7) : m; }

async function listModelsOnce(ver) {
  const url = `https://generativelanguage.googleapis.com/${ver}/models?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const r = await fetch(url);
  const text = await r.text();
  return { ver, status: r.status, body: text, ct: r.headers.get("content-type") || "application/json" };
}
async function listModels() {
  if (!GEMINI_API_KEY) return { status: 500, body: { error: "GEMINI_API_KEY not set" }, ct: "application/json" };
  // Try v1 then v1beta
  const v1 = await listModelsOnce("v1");
  if (v1.status !== 404) return v1;
  const vbeta = await listModelsOnce("v1beta");
  return vbeta;
}

async function generateWithModel(model, prompt, forceVer) {
  // Normalize requested model and build fallbacks
  const base = (model || "").replace(/^models\//, "");
  const candidates = Array.from(new Set([
    base,
    base && !base.endsWith("-001") ? `${base}-001` : base,
    "gemini-1.5-flash-001",
    "gemini-1.5-pro-001",
    "gemini-pro",
  ].filter(Boolean)));

  // Try v1 first, then v1beta (unless ver is forced via query)
  const versions = forceVer ? [forceVer] : ["v1", "v1beta"];
  const tried = [];

  for (const ver of versions) {
    for (const m of candidates) {
      const url = `https://generativelanguage.googleapis.com/${ver}/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }]}],
          generationConfig: { maxOutputTokens: 128 }
        })
      });
      const text = await r.text();
      tried.push({ ver, model: m, status: r.status });
      if (r.status !== 404) {
        return { ok: true, ver, status: r.status, text, ct: r.headers.get("content-type") || "application/json", tried };
      }
    }
  }

  // Nothing worked
  return {
    ok: false,
    status: 404,
    text: JSON.stringify({ error: "Model not found on v1 or v1beta", tried }, null, 2),
    ct: "application/json",
    tried
  };
}


const server = http.createServer(async (req, res) => {
  const raw = req.url || "/";
  const url = new URL(raw, `http://${HOST}:${PORT}`);
  const path = url.pathname.replace(/\/+$/,"").toLowerCase();

  if (path === "/ping") return send(res, 200, { ok: true });

  if (path === "/list-models") {
    if (!GEMINI_API_KEY) return send(res, 500, { error: "GEMINI_API_KEY not set" });
    try {
      const out = await listModels();
      res.statusCode = out.status;
      res.setHeader("Content-Type", out.ct);
      res.setHeader("Cache-Control", "no-store");
      return res.end(out.body);
    } catch (e) {
      return send(res, 500, { error: "ListModels failed", detail: String(e) });
    }
  }

  // Keep your same route name; now it talks to Gemini
  if (path === "/test-hf") {
    if (!GEMINI_API_KEY) return send(res, 500, { error: "GEMINI_API_KEY not set" });

    const model = stripPrefix(url.searchParams.get("model")) || DEFAULT_MODELS[0] || "gemini-1.5-flash-latest";
    const forceVer = url.searchParams.get("ver"); // "v1" or "v1beta" to force
    const prompt = url.searchParams.get("prompt") || "Say hello from Gemini!";

    try {
      const out = await generateWithModel(model, prompt, forceVer);
      res.statusCode = out.status;
      res.setHeader("Content-Type", out.ct);
      res.setHeader("Cache-Control", "no-store");
      // If text is already a string (raw HF/Gemini), send as-is
      return res.end(out.text);
    } catch (e) {
      return send(res, 500, { error: "Gemini request failed", detail: String(e) });
    }
  }

  if (path === "/favicon.ico") { res.statusCode = 204; return res.end(); }
  res.statusCode = 404; res.end("Not Found");
});

server.listen(PORT, HOST, () => {
  console.log(`BARE listening on http://${HOST}:${PORT}`);
  if (!GEMINI_API_KEY) console.warn("⚠️  GEMINI_API_KEY not set — /test-hf will error until you set it.");
});
