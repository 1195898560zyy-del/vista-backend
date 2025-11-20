// =======================
// VISTA Backend — Full Version
// Supports Unsplash paging + OpenAI generation
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

// =======================
// UNSPLASH — SUPPORT PAGING
// =======================
app.get("/api/unsplash", async (req, res) => {
  const q = req.query.q;
  if (!q) {
    return res.status(400).json({ error: "Missing ?q=" });
  }

  const page = Number(req.query.page || 1);
  const perPage = 30;

  try {
    const url =
      `https://api.unsplash.com/search/photos?` +
      `query=${encodeURIComponent(q)}` +
      `&page=${page}` +
      `&per_page=${perPage}` +
      `&client_id=${process.env.UNSPLASH_KEY}`;

    const r = await fetch(url);
    const data = await r.json();

    if (data.errors) {
      return res.status(500).json({ error: data.errors });
    }

    const images = data.results?.map(x => x.urls.regular) || [];

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

// =======================
// OPENAI IMAGE GENERATION
// =======================
app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, size, model } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_KEY}`
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

// =======================
// Start server
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 VISTA backend running at http://localhost:${PORT}`);
});
