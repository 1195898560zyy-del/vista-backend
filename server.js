// ----------------------
// VISTA Backend — Final Clean Working Version
// ----------------------

const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Load environment variables
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ----------------------
// TEST ROUTE
// ----------------------
app.get("/", (req, res) => {
  res.send("VISTA backend is running.");
});

// ----------------------
// UNSPLASH
// ----------------------
app.get("/api/unsplash", async (req, res) => {
  const q = req.query.q;
  if (!q) {
    return res.status(400).json({ error: "Missing q parameter" });
  }

  try {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&page=1&per_page=10`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Client-ID ${process.env.UNSPLASH_KEY}`,
      },
    });

    const raw = await response.json();

    if (raw.errors) {
      return res.status(500).json({ error: raw.errors });
    }

    const images = raw.results?.map((r) => r.urls?.regular) || [];

    res.json({ images });
  } catch (err) {
    console.error("Unsplash Error:", err);
    res.status(500).json({ error: "Unsplash proxy failed" });
  }
});

// ----------------------
// OPENAI IMAGE GENERATION
// ----------------------
app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, model, size } = req.body;

    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_KEY}`,
      },
      body: JSON.stringify({
        prompt,
        model: model || "gpt-image-1",
        n: 3,
        size: size || "1024x1024",
      }),
    });

    const data = await response.json();
    res.json(data);

  } catch (err) {
    console.error("OpenAI Error:", err);
    res.status(500).json({ error: "OpenAI proxy failed" });
  }
});

// ----------------------
// START SERVER
// ----------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 VISTA backend running at http://localhost:${PORT}`);
});
