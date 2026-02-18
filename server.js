// =======================
// VISTA Backend — Ultimate Version
// Supports Unsplash + Pexels + AI + AI Batch
// =======================

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const FormData = require("form-data");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: __dirname + "/.env" });

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "..", "vistapj")));

const sessions = new Map();

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
// SPEECH-TO-TEXT (OPENAI WHISPER)
// =======================================================
app.post("/api/transcribe", async (req, res) => {
  const { audio, mime } = req.body || {};
  if (!audio) return res.status(400).json({ error: "Missing audio" });

  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
  if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  try {
    const buffer = Buffer.from(audio, "base64");
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", buffer, {
      filename: "speech.webm",
      contentType: mime || "audio/webm"
    });

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(500).json({ error: data.error?.message || "Transcription failed" });
    }
    res.json({ text: data.text || "" });
  } catch (err) {
    console.error("Transcribe Error:", err);
    res.status(500).json({ error: "Transcription failed" });
  }
});

// =======================================================
// AGENT ROUTER + EXECUTOR (SEARCH/GENERATE/REFINE)
// =======================================================
async function callOpenAIResponses({ input, tools, previous_response_id }) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const model = process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini";
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: Array.isArray(input) ? input : [],
      tools,
      tool_choice: "auto",
      temperature: 0.6,
      previous_response_id
    })
  });

  const data = await r.json();
  if (!r.ok) {
    throw new Error(data.error?.message || "OpenAI responses failed");
  }
  return data;
}

function extractOutputText(response) {
  if (!response) return "";
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  const output = Array.isArray(response.output) ? response.output : [];
  let text = "";
  output.forEach((item) => {
    if (!item) return;
    if (item.type === "output_text" && item.text) {
      text += item.text;
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      item.content.forEach((part) => {
        if (!part) return;
        if ((part.type === "text" || part.type === "output_text") && part.text) {
          text += part.text;
        }
      });
    }
  });
  return text;
}

function extractToolCalls(response) {
  const output = Array.isArray(response && response.output) ? response.output : [];
  const calls = [];
  output.forEach((item) => {
    if (!item) return;
    if (item.type === "tool_call" || item.type === "function_call") {
      calls.push(item);
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      item.content.forEach((part) => {
        if (!part) return;
        if (part.type === "tool_call" || part.type === "function_call") {
          calls.push(part);
        }
      });
    }
  });
  return calls;
}

function parseISODate(text) {
  const match = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return match ? match[1] : "";
}

function formatDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function extractCity(text) {
  const inMatch = text.match(/\bin\s+([a-z\s]+)$/i);
  if (inMatch && inMatch[1]) return inMatch[1].trim();
  const weatherMatch = text.match(/([a-z\s]+)\s+weather/i);
  if (weatherMatch && weatherMatch[1]) return weatherMatch[1].trim();
  const zhMatch = text.match(/([\u4e00-\u9fa5A-Za-z\s]+)天气/);
  if (zhMatch && zhMatch[1]) return zhMatch[1].trim();
  return "";
}

function inferToolFromText(message, state) {
  const text = String(message || "").toLowerCase().trim();
  if (!text) return null;

  const wantsHistory = /yesterday|last week|last 7 days|过去|昨天|前天|上周/.test(text);
  if (wantsHistory) {
    const city = extractCity(text);
    const date =
      parseISODate(text) ||
      (text.includes("yesterday") || text.includes("昨天") ? formatDateOffset(-1) : "") ||
      (text.includes("前天") ? formatDateOffset(-2) : "") ||
      (text.includes("last week") || text.includes("上周") ? formatDateOffset(-7) : "");
    if (!city) {
      return { reply: "Which city?" };
    }
    if (!date) {
      return { reply: "Which date should I check?" };
    }
    return {
      tools: [
        { name: "get_weather_history", args: { city, date } }
      ]
    };
  }

  const wantsSearch = /show me|search|find|image|picture|photo|搜|搜索|找|图|图片|照片/.test(text);
  if (wantsSearch && !/weather|天气/.test(text)) {
    let query = text
      .replace(/show me|search|find|images of|image of|pictures of|picture of|photos of|photo of/gi, "")
      .replace(/搜|搜索|找|图片|照片|图/g, "")
      .trim();
    if (!query) {
      return { reply: "What should I search for?" };
    }
    const ratio = state?.preferred_ratio || state?.ratio || "1:1";
    return {
      tools: [
        { name: "search_library", args: { query, ratio } }
      ]
    };
  }

  const wantsGenerate = /generate|create|make|draw|生成|画|创作/.test(text);
  if (wantsGenerate) {
    let prompt = text
      .replace(/generate|create|make|draw|生成|画|创作/gi, "")
      .trim();
    if (!prompt) {
      return { reply: "What should I generate?" };
    }
    const ratio = state?.preferred_ratio || state?.ai_ratio || "1:1";
    return {
      tools: [
        { name: "generate_ai", args: { prompt, aspect_ratio: ratio } }
      ]
    };
  }

  return null;
}

async function executeToolCall(toolCall) {
  const name =
    toolCall.name ||
    (toolCall.function && toolCall.function.name) ||
    toolCall.tool_name;
  const rawArgs =
    toolCall.arguments ||
    (toolCall.function && toolCall.function.arguments) ||
    toolCall.arguments_json ||
    "{}";
  let args = {};
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs);
    } catch (err) {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    args = rawArgs;
  }
  const localBase = `http://localhost:${process.env.PORT || 3000}`;
  const baseUrl = process.env.PUBLIC_BASE_URL || localBase;

  if (name === "search_library") {
    const { query, source, ratio } = args;
    if (!query) {
      throw new Error("Missing query");
    }
    const selectedSource =
      source === "pexels" || source === "unsplash" ? source : "unsplash";
    if (selectedSource === "unsplash") {
      const r = await fetch(
        `${baseUrl}/api/unsplash` +
          `?q=${encodeURIComponent(query)}` +
          `&random=1` +
          `&ratio=${encodeURIComponent(ratio || "1:1")}`
      );
      const data = await r.json();
      if (!r.ok || data.error) {
        throw new Error(data.error || "Unsplash failed");
      }
      return { images: data.images || [], source: selectedSource };
    }
    if (selectedSource === "pexels") {
      const r = await fetch(
        `${baseUrl}/api/pexels` +
          `?q=${encodeURIComponent(query)}` +
          `&random=1` +
          `&ratio=${encodeURIComponent(ratio || "1:1")}`
      );
      const data = await r.json();
      if (!r.ok || data.error) {
        throw new Error(data.error || "Pexels failed");
      }
      return { images: data.images || [], source: selectedSource };
    }
    throw new Error("Unsupported source");
  }

  if (name === "generate_ai") {
    const { prompt, count, aspect_ratio } = args;
    if (!prompt) throw new Error("Missing prompt");
    const r = await fetch(
      `${baseUrl}/api/replicate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          count: count || 1,
          aspect_ratio: aspect_ratio || "1:1"
        })
      }
    );
    const data = await r.json();
    if (!r.ok || data.error) {
      throw new Error(data.error || "Flux failed");
    }
    return { images: data.images || [] };
  }

  if (name === "refine_image") {
    const { prompt, input_image } = args;
    if (!prompt || !input_image) throw new Error("Missing prompt/input_image");
    const r = await fetch(
      `${baseUrl}/api/refine`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          input_image
        })
      }
    );
    const data = await r.json();
    if (!r.ok || data.error) {
      throw new Error(data.error || "Refine failed");
    }
    return { image: data.image || "" };
  }

  if (name === "set_view") {
    const { view } = args;
    if (!view) throw new Error("Missing view");
    return { view };
  }

  if (name === "refresh_weather") {
    return { ok: true };
  }

  if (name === "get_weather_history") {
    const { city, date } = args || {};
    if (!city || !date) {
      throw new Error("Missing city/date");
    }
    const geoUrl =
      `https://geocoding-api.open-meteo.com/v1/search` +
      `?name=${encodeURIComponent(city)}` +
      `&count=1&language=en&format=json`;
    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();
    if (!geoRes.ok || !geoData || !geoData.results || !geoData.results.length) {
      throw new Error("City not found");
    }
    const place = geoData.results[0];
    const lat = place.latitude;
    const lon = place.longitude;
    const day = String(date).slice(0, 10);
    const historyUrl =
      `https://archive-api.open-meteo.com/v1/archive` +
      `?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lon)}` +
      `&start_date=${encodeURIComponent(day)}` +
      `&end_date=${encodeURIComponent(day)}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max` +
      `&timezone=auto`;
    const historyRes = await fetch(historyUrl);
    const historyData = await historyRes.json();
    if (!historyRes.ok || !historyData || !historyData.daily) {
      throw new Error("Weather history failed");
    }
    const daily = historyData.daily;
    return {
      city: place.name,
      country: place.country || "",
      date: day,
      temperature_max: daily.temperature_2m_max ? daily.temperature_2m_max[0] : null,
      temperature_min: daily.temperature_2m_min ? daily.temperature_2m_min[0] : null,
      precipitation_sum: daily.precipitation_sum ? daily.precipitation_sum[0] : null,
      windspeed_max: daily.windspeed_10m_max ? daily.windspeed_10m_max[0] : null
    };
  }

  throw new Error("Unknown tool");
}

app.post("/api/agent", async (req, res) => {
  const { message, summary, state } = req.body || {};
  if (!message) {
    return res.status(400).json({ error: "Missing message" });
  }

  const tools = [
    {
      type: "function",
      name: "search_library",
      description: "Search images from the best library source.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          source: { type: "string", enum: ["unsplash", "pexels"] },
          ratio: { type: "string", enum: ["1:1", "4:3", "16:9", "3:4", "9:16"] }
        },
        required: ["query"]
      }
    },
    {
      type: "function",
      name: "set_view",
      description: "Switch the presenter view between weather and gallery.",
      parameters: {
        type: "object",
        properties: {
          view: { type: "string", enum: ["weather", "gallery"] }
        },
        required: ["view"]
      }
    },
    {
      type: "function",
      name: "refresh_weather",
      description: "Refresh the weather data and wallpaper.",
      parameters: {
        type: "object",
        properties: {}
      }
    },
    {
      type: "function",
      name: "get_weather_history",
      description: "Get historical daily weather for a city and date.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" }
        },
        required: ["city", "date"]
      }
    },
    {
      type: "function",
      name: "generate_ai",
      description: "Generate images with Flux.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          count: { type: "integer", minimum: 1, maximum: 5 },
          aspect_ratio: { type: "string", enum: ["1:1", "4:3", "16:9", "3:4", "9:16"] }
        },
        required: ["prompt"]
      }
    },
    {
      type: "function",
      name: "refine_image",
      description: "Refine a single image with Flux Kontext.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          input_image: { type: "string" }
        },
        required: ["prompt", "input_image"]
      }
    }
  ];

  const system = [
    "You are VISTA Agent. You can chat normally or call a tool.",
    "Use tools only when user intent requires system action.",
    "If required parameters are missing, ask a brief question instead of calling tools.",
    "Do not ask the user which image library to use; choose automatically (default to Unsplash).",
    "If state includes preferred_ratio, use it when ratio/aspect_ratio is missing.",
    "Use set_view to switch between weather and gallery, and refresh_weather to update weather.",
    "If the user asks for historical weather (e.g., yesterday, last week, or a specific date), call get_weather_history instead of refresh_weather.",
    "After tools run, always produce a natural language reply summarizing results.",
    "Never claim you executed a tool unless you actually called it.",
    "Prefer a single tool call when possible."
  ].join(" ");

  const userContext = [
    summary ? `Conversation summary: ${summary}` : null,
    state ? `Global state: ${JSON.stringify(state)}` : null,
    `User message: ${message}`
  ].filter(Boolean).join("\n");

  try {
    const first = await callOpenAIResponses({
      input: [
        { role: "system", content: system },
        { role: "user", content: userContext }
      ],
      tools
    });

    const toolCalls = extractToolCalls(first);
    const replyText = extractOutputText(first);

    if (!toolCalls.length) {
      const inferred = inferToolFromText(message, state || {});
      if (inferred && inferred.reply) {
        return res.json({
          tools: [],
          reply: inferred.reply
        });
      }
      if (inferred && Array.isArray(inferred.tools) && inferred.tools.length) {
        const toolResults = [];
        for (const tool of inferred.tools) {
          const result = await executeToolCall({
            name: tool.name,
            arguments: JSON.stringify(tool.args || {})
          });
          toolResults.push({
            name: tool.name,
            args: tool.args || {},
            result
          });
        }
        const fallbackReply = (() => {
          const firstTool = toolResults[0];
          if (!firstTool) return "";
          if (firstTool.name === "get_weather_history") {
            const r = firstTool.result || {};
            if (r && r.city && r.date) {
              const max = r.temperature_max != null ? `${r.temperature_max}°C` : "—";
              const min = r.temperature_min != null ? `${r.temperature_min}°C` : "—";
              const rain = r.precipitation_sum != null ? `${r.precipitation_sum}mm` : "—";
              const wind = r.windspeed_max != null ? `${r.windspeed_max} m/s` : "—";
              return `${r.city} ${r.date}: high ${max}, low ${min}, rain ${rain}, wind ${wind}.`;
            }
          }
          if (firstTool.name === "search_library") {
            const count = Array.isArray(firstTool.result?.images) ? firstTool.result.images.length : 0;
            return count ? `Found ${count} images.` : "Search completed.";
          }
          if (firstTool.name === "generate_ai") {
            const count = Array.isArray(firstTool.result?.images) ? firstTool.result.images.length : 0;
            return count ? `Generated ${count} images.` : "Generation completed.";
          }
          return "Done.";
        })();
        return res.json({
          tools: toolResults,
          reply: fallbackReply || "Done."
        });
      }
      return res.json({
        tools: [],
        reply: replyText || "Got it. What would you like to do next?"
      });
    }

    const toolResults = [];
    const toolOutputs = [];
    for (const call of toolCalls) {
      const callId = call.id || call.call_id;
      const toolArgsRaw = call.arguments || call.arguments_json || "{}";
      let toolArgs = {};
      if (typeof toolArgsRaw === "string") {
        try {
          toolArgs = JSON.parse(toolArgsRaw);
        } catch (err) {
          toolArgs = {};
        }
      } else if (toolArgsRaw && typeof toolArgsRaw === "object") {
        toolArgs = toolArgsRaw;
      }
      const result = await executeToolCall(call);
      const toolName = call.name || (call.function && call.function.name) || "";
      toolResults.push({
        name: toolName,
        args: toolArgs,
        result
      });
      if (callId) {
        toolOutputs.push({
          tool_call_id: callId,
          output: JSON.stringify(result)
        });
      }
    }

    const followupInput = toolOutputs.map((toolOutput) => ({
      type: "tool_output",
      tool_call_id: toolOutput.tool_call_id,
      output: toolOutput.output
    }));
    followupInput.push({
      role: "user",
      content: "Summarize the tool results in a helpful reply."
    });

    const second = await callOpenAIResponses({
      input: followupInput,
      tools,
      previous_response_id: first.id
    });

    const secondReply = extractOutputText(second);

    const fallbackReply = (() => {
      if (!toolResults.length) return "";
      const firstTool = toolResults[0];
      if (firstTool.name === "get_weather_history") {
        const r = firstTool.result || {};
        if (r && r.city && r.date) {
          const max = r.temperature_max != null ? `${r.temperature_max}°C` : "—";
          const min = r.temperature_min != null ? `${r.temperature_min}°C` : "—";
          const rain = r.precipitation_sum != null ? `${r.precipitation_sum}mm` : "—";
          const wind = r.windspeed_max != null ? `${r.windspeed_max} m/s` : "—";
          return `${r.city} ${r.date}: high ${max}, low ${min}, rain ${rain}, wind ${wind}.`;
        }
      }
      if (firstTool.name === "refresh_weather") {
        return "I have updated the weather data. Do you want today or the past 7 days?";
      }
      if (firstTool.name === "set_view") {
        return "View updated.";
      }
      if (firstTool.name === "search_library") {
        const count = Array.isArray(firstTool.result?.images) ? firstTool.result.images.length : 0;
        return count ? `Found ${count} images.` : "Search completed.";
      }
      if (firstTool.name === "generate_ai") {
        const count = Array.isArray(firstTool.result?.images) ? firstTool.result.images.length : 0;
        return count ? `Generated ${count} images.` : "Generation completed.";
      }
      if (firstTool.name === "refine_image") {
        return "Refine completed.";
      }
      return "Done.";
    })();

    return res.json({
      tools: toolResults,
      reply: secondReply || replyText || fallbackReply || "Got it. What would you like to do next?"
    });
  } catch (err) {
    console.error("Agent Error:", err);
    res.status(500).json({ error: err.message || "Agent failed" });
  }
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
  const ratio = req.query.ratio || "";
  const width = Number(req.query.w || 0);
  const height = Number(req.query.h || 0);
  const orientation = ratio.startsWith("1:1")
    ? "squarish"
    : (ratio === "4:3" || ratio === "16:9")
      ? "landscape"
      : (ratio === "3:4" || ratio === "9:16")
        ? "portrait"
        : "";

  try {
    const orientationParam = orientation ? `&orientation=${orientation}` : "";
    const url = random
      ? `https://api.unsplash.com/photos/random?query=${encodeURIComponent(q)}` +
        `&count=${perPage}` +
        `${orientationParam}` +
        `&client_id=${process.env.UNSPLASH_KEY}`
      : `https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}` +
        `&page=${page}` +
        `&per_page=${perPage}` +
        `${orientationParam}` +
        `&client_id=${process.env.UNSPLASH_KEY}`;

    const r = await fetch(url);
    const data = await r.json();

    if (data.errors)
      return res.status(500).json({ error: data.errors });

    const results = Array.isArray(data) ? data : (data.results || []);
    const images = results.map((x) => {
      if (!x || !x.urls) return null;
      if (width > 0 && x.urls.raw) {
        const hParam = height > 0 ? `&h=${height}` : "";
        return `${x.urls.raw}&w=${width}${hParam}&auto=format&fit=crop`;
      }
      return x.urls.regular;
    }).filter(Boolean);

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
  const ratio = req.query.ratio || "";
  const orientation = ratio.startsWith("1:1")
    ? "square"
    : (ratio === "4:3" || ratio === "16:9")
      ? "landscape"
      : (ratio === "3:4" || ratio === "9:16")
        ? "portrait"
        : "";

  try {
    const orientationParam = orientation ? `&orientation=${orientation}` : "";
    const r = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=30&page=${pickPage}${orientationParam}`,
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
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=30&page=1${orientationParam}`,
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
// 3) WEATHER — OPENWEATHER PROXY
// =======================================================
app.get("/api/weather", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "Missing or invalid lat/lon" });
  }

  const key = process.env.WEATHER_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Missing WEATHER_API_KEY" });
  }

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather` +
      `?lat=${encodeURIComponent(lat)}` +
      `&lon=${encodeURIComponent(lon)}` +
      `&units=metric` +
      `&appid=${encodeURIComponent(key)}`;

    const r = await fetch(url);
    const data = await r.json();

    if (!r.ok) {
      return res.status(500).json({ error: data.message || "Weather request failed" });
    }

    const info = data.weather && data.weather[0] ? data.weather[0] : {};
    res.json({
      city: data.name,
      temp: data.main ? data.main.temp : null,
      description: info.description || "",
      main: info.main || "",
      icon: info.icon || "",
      humidity: data.main ? data.main.humidity : null,
      wind: data.wind ? data.wind.speed : null,
      dt: data.dt,
      timezone: data.timezone
    });
  } catch (err) {
    console.error("Weather Error:", err);
    res.status(500).json({ error: "Weather proxy failed" });
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
// 7) REPLICATE — Flux Kontext Pro (image refine)
// =======================================================
app.post("/api/refine", async (req, res) => {
  const { prompt, input_image } = req.body;

  if (!prompt || !input_image) {
    return res.status(400).json({ error: "Missing prompt or input_image" });
  }

  try {
    const token = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
    if (!token) {
      return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN" });
    }

    const response = await fetch(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          input: {
            prompt,
            input_image,
            output_format: "jpg"
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

    const output = prediction.output;
    const imageUrl = output && output.url ? output.url : output;
    if (!imageUrl) {
      return res.status(500).json({ error: "No output image" });
    }

    res.json({ image: imageUrl });

  } catch (err) {
    console.error("Refine Error:", err);
    res.status(500).json({ error: "Refine request failed" });
  }
});

// =======================================================
// Start server
// =======================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 VISTA backend running at http://localhost:${PORT}`);
});
