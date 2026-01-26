// =======================
// VISTA Backend — Ultimate Version
// Supports Unsplash + Pexels + Lexica + AI + AI Batch
// =======================

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: __dirname + "/.env" });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "vistapj")));

const sessions = new Map();
const lexicaCache = new Map();

function createSessionId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  ).toUpperCase();
}

function createShortCode() {
  return "VISTA-" + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function ensureSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) return sessions.get(sessionId);
  return null;
}

// Test route
app.get("/", (req, res) => {
  res.send("VISTA backend is running.");
});

// =======================================================
// SESSION + REMOTE COMMANDS (MVP)
// =======================================================
app.post("/api/session", (req, res) => {
  const sessionId = createSessionId();
  const code = createShortCode();
  sessions.set(sessionId, {
    code,
    queue: [],
    commands: new Map(),
    createdAt: Date.now()
  });
  res.json({ session: sessionId, code });
});

app.get("/api/session/:id", (req, res) => {
  const sessionId = req.params.id;
  if (!sessionId) return res.status(400).json({ error: "Missing session id" });
  if (!sessions.has(sessionId)) return res.status(404).json({ error: "Session not found" });
  res.json({ ok: true });
});

app.post("/api/cmd", (req, res) => {
  const { session, command } = req.body || {};
  if (!session || !command) {
    return res.status(400).json({ error: "Missing session or command" });
  }

  const sess = ensureSession(session);
  if (!sess) {
    return res.status(404).json({ error: "Session not found" });
  }

  const id = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
  const record = {
    id,
    ...command,
    status: "sent",
    ts: Date.now()
  };

  sess.queue.push(record);
  sess.commands.set(id, record);

  res.json({ ok: true, id });
});

app.get("/api/check", (req, res) => {
  const session = req.query.session;
  if (!session) return res.status(400).json({ error: "Missing session" });

  const sess = getSession(session);
  if (!sess) return res.status(404).json({ error: "Session not found" });

  const cmd = sess.queue.shift() || null;
  if (cmd) {
    cmd.status = "executed";
    sess.commands.set(cmd.id, cmd);
  }

  res.json({ command: cmd });
});

app.get("/api/status", (req, res) => {
  const session = req.query.session;
  const id = req.query.id;
  if (!session || !id) return res.status(400).json({ error: "Missing session or id" });

  const sess = getSession(session);
  if (!sess) return res.status(404).json({ error: "Session not found" });

  const cmd = sess.commands.get(id);
  if (!cmd) return res.status(404).json({ error: "Command not found" });

  res.json({ status: cmd.status });
});

// =======================================================
// 1) UNSPLASH — PAGINATION SUPPORT
// =======================================================
app.get("/api/unsplash", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Missing ?q=" });

  const page = Number(req.query.page || 1);
  const perPage = 30;
  const random = req.query.random === "1" || req.query.random === "true";

  try {
    const url = random
      ? `https://api.unsplash.com/photos/random?query=${encodeURIComponent(q)}` +
        `&count=${perPage}` +
        `&client_id=${process.env.UNSPLASH_KEY}`
      : `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}` +
        `&page=${page}` +
        `&per_page=${perPage}` +
        `&client_id=${process.env.UNSPLASH_KEY}`;

    const r = await fetch(url);
    const data = await r.json();

    if (data.errors)
      return res.status(500).json({ error: data.errors });

    const results = Array.isArray(data) ? data : (data.results || []);
    const images = results.map(x => x.urls.regular);

    res.json({
      images,
      page: random ? 1 : page,
      totalPages: random ? 1 : (data.total_pages || 1)
    });

  } catch (err) {
    console.error("Unsplash Error:", err);
    res.status(500).json({ error: "Unsplash proxy failed" });
  }
});


// =======================================================
// 2) PEXELS — SIMPLE SEARCH
// =======================================================
app.get("/api/pexels", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Missing ?q=" });
  const random = req.query.random === "1" || req.query.random === "true";
  const page = Number(req.query.page || 1);
  const pickPage = random ? Math.floor(Math.random() * 50) + 1 : page;

  try {
    const r = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=30&page=${pickPage}`,
      {
        headers: { Authorization: process.env.PEXELS_KEY }
      }
    );

    if (!r.ok) {
      const text = await r.text();
      return res.status(500).json({ error: `Pexels ${r.status}: ${text}` });
    }

    let data = await r.json();
    let images = data.photos?.map(p => p.src.large) || [];

    if (random && images.length === 0) {
      const retry = await fetch(
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=30&page=1`,
        {
          headers: { Authorization: process.env.PEXELS_KEY }
        }
      );
      if (!retry.ok) {
        const text = await retry.text();
        return res.status(500).json({ error: `Pexels ${retry.status}: ${text}` });
      }
      data = await retry.json();
      images = data.photos?.map(p => p.src.large) || [];
    }

    res.json({ images });

  } catch (err) {
    console.error("Pexels Error:", err);
    res.status(500).json({ error: "Pexels proxy failed" });
  }
});


// =======================================================
// 3) LEXICA — PUBLIC API, AI-STYLE GALLERY
// =======================================================
app.get("/api/lexica", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Missing ?q=" });
  const page = Number(req.query.page || 1);
  const perPage = 30;

  try {
    const cacheKey = q.toLowerCase();
    const cached = lexicaCache.get(cacheKey);
    const now = Date.now();

    let images = cached && now - cached.ts < 2 * 60 * 1000 ? cached.images : null;

    if (!images) {
      let r = await fetch(`https://lexica.art/api/v1/search?q=${encodeURIComponent(q)}`);
      const contentType = r.headers.get("content-type") || "";

      if (!r.ok || !contentType.includes("application/json")) {
        const text = await r.text();
        // Retry once on upstream error pages
        if (r.status >= 500) {
          r = await fetch(`https://lexica.art/api/v1/search?q=${encodeURIComponent(q)}`);
          const ct2 = r.headers.get("content-type") || "";
          if (!r.ok || !ct2.includes("application/json")) {
            const text2 = await r.text();
            return res.status(500).json({ error: `Lexica ${r.status}: ${text2}` });
          }
        } else {
          return res.status(500).json({ error: `Lexica ${r.status}: ${text}` });
        }
      }

      const data = await r.json();
      images = data.images?.map(x => x.src) || [];

      // Shuffle for variety
      for (let i = images.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [images[i], images[j]] = [images[j], images[i]];
      }

      lexicaCache.set(cacheKey, { images, ts: now });
    }

    if (!images.length) return res.json({ images: [] });

    const start = ((page - 1) % Math.ceil(images.length / perPage)) * perPage;
    const slice = images.slice(start, start + perPage);

    res.json({ images: slice, page });

  } catch (err) {
    console.error("Lexica Error:", err);
    res.status(500).json({ error: "Lexica proxy failed" });
  }
});


// =======================================================
// 4) OPENAI — SINGLE IMAGE GENERATION
// =======================================================
app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, size, model } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    if (!process.env.OPENAI_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_KEY" });
    }

    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_KEY}`
      },
      body: JSON.stringify({
        prompt,
        n: 3,
        size: size || "1024x1024",
        model: model || "gpt-image-1"
      })
    });

    const data = await response.json();
    res.json(data);

  } catch (err) {
    console.error("OpenAI Error:", err);
    res.status(500).json({ error: "OpenAI proxy failed" });
  }
});


// =======================================================
// 5) OPENAI — BATCH (MULTI-STYLE) GENERATION
// =======================================================
// prompts: ["dog, cinematic", "dog, watercolor", ...]
app.post("/api/generate_batch", async (req, res) => {
  try {
    const { prompts, size = "1024x1024", model = "gpt-image-1" } = req.body;

    if (!Array.isArray(prompts) || prompts.length === 0) {
      return res.status(400).json({ error: "prompts must be array" });
    }
    if (!process.env.OPENAI_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_KEY" });
    }

    const results = [];
    const errors = [];

    for (const prompt of prompts) {
      const r = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_KEY}`
        },
        body: JSON.stringify({
          prompt,
          n: 1,
          size,
          model
        })
      });

      const data = await r.json();
      if (data.data?.[0]) {
        results.push(data.data[0]);
      } else if (data.error) {
        errors.push(data.error.message || data.error);
      }
    }

    res.json({ data: results, error: errors[0] });

  } catch (err) {
    console.error("Batch Error:", err);
    res.status(500).json({ error: "Batch generation failed" });
  }
});

// =======================================================
// 6) REPLICATE — Imagen-4
// =======================================================
app.post("/api/replicate", async (req, res) => {
  const { prompt, aspect_ratio, count } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Missing prompt" });
  }

  try {
    const token = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
    if (!token) {
      return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN" });
    }

    const response = await fetch(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          input: {
            prompt,
            num_outputs: count || 1,
            aspect_ratio: aspect_ratio || "1:1"
          }
        })
      }
    );

    let prediction = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: prediction.error || "Replicate request failed" });
    }

    const startedAt = Date.now();
    while (
      prediction.status !== "succeeded" &&
      prediction.status !== "failed" &&
      prediction.status !== "canceled"
    ) {
      if (Date.now() - startedAt > 120000) {
        return res.status(500).json({ error: "Replicate request timed out" });
      }
      await new Promise((r) => setTimeout(r, 1200));
      const poll = await fetch(prediction.urls.get, {
        headers: { Authorization: `Bearer ${token}` }
      });
      prediction = await poll.json();
    }

    if (prediction.status !== "succeeded") {
      return res.status(500).json({ error: prediction.error || "Replicate failed" });
    }

    const output = Array.isArray(prediction.output) ? prediction.output : [];
    const images = output.map((item) => (item && item.url ? item.url : item));

    res.json({
      images,
      status: prediction.status
    });

  } catch (err) {
    console.error("Replicate Error:", err);
    res.status(500).json({ error: "Replicate request failed" });
  }
});

// =======================================================
// Start server
// =======================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 VISTA backend running at http://localhost:${PORT}`);
});
