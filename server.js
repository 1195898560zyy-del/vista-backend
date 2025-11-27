// =======================
// VISTA Backend — Ultimate Version
// Supports Unsplash + Pexels + Lexica + AI + AI Batch
// =======================

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const dotenv = require("dotenv");

dotenv.config({ path: __dirname + "/.env" });

const app = express();
app.use(cors());
app.use(express.json());

// Test route
app.get("/", (req, res) => {
  res.send("VISTA backend is running.");
});


// =======================================================
// 1) UNSPLASH — PAGINATION SUPPORT
// =======================================================
app.get("/api/unsplash", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: "Missing ?q=" });

  const page = Number(req.query.page || 1);
  const perPage = 30;

  try {
    const url =
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}` +
      `&page=${page}` +
      `&per_page=${perPage}` +
      `&client_id=${process.env.UNSPLASH_KEY}`;

    const r = await fetch(url);
    const data = await r.json();

    if (data.errors)
      return res.status(500).json({ error: data.errors });

    const images =
      data.results?.map(x => x.urls.regular) || [];

    res.json({
      images,
      page,
      totalPages: data.total_pages || 1
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

  try {
    const r = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=30`,
      {
        headers: { Authorization: process.env.PEXELS_KEY }
      }
    );

    const data = await r.json();
    const images = data.photos?.map(p => p.src.large) || [];

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

  try {
    const r = await fetch(`https://lexica.art/api/v1/search?q=${encodeURIComponent(q)}`);
    const data = await r.json();

    const images =
      data.images?.map(x => x.src) || [];

    res.json({ images });

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

    const results = [];

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
      if (data.data?.[0]) results.push(data.data[0]);
    }

    res.json({ data: results });

  } catch (err) {
    console.error("Batch Error:", err);
    res.status(500).json({ error: "Batch generation failed" });
  }
});

// =======================================================
// 6) REPLICATE — Imagen-4
// =======================================================
app.post("/api/replicate", async (req, res) => {
  const { prompt, aspect_ratio } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Missing prompt" });
  }

  try {
    const response = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.REPLICATE_API_KEY}`
      },
      body: JSON.stringify({
        version: "google/imagen-4",   // 官方模型名称（Replicate 已托管）
        input: {
          prompt,
          aspect_ratio: aspect_ratio || "1:1"
        }
      })
    });

    const prediction = await response.json();

    // Replicate 返回结构不同：图在 prediction.output
    res.json({
      images: prediction.output || [],
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
