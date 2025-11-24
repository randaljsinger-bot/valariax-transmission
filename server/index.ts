import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import pg from "pg";

// ---------- Postgres: voice usage tracking ----------
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Ensure the usage table exists (runs once on boot)
async function ensureUsageTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_usage (
      user_id TEXT NOT NULL,
      period  TEXT NOT NULL,
      mode    TEXT NOT NULL,
      bursts_used INTEGER NOT NULL DEFAULT 0,
      seconds_used INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, period, mode)
    );
  `);
}
ensureUsageTable().catch(console.error);

// Current billing period (YYYY-MM)
function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Read usage
async function getUsage(userId: string, mode: string, period: string) {
  const { rows } = await pool.query(
    `SELECT bursts_used, seconds_used
     FROM voice_usage
     WHERE user_id=$1 AND mode=$2 AND period=$3`,
    [userId, mode, period]
  );
  return rows[0] || { bursts_used: 0, seconds_used: 0 };
}

// Increment usage by 1 burst
async function incrementUsage(
  userId: string,
  mode: string,
  period: string,
  seconds: number
) {
  await pool.query(
    `INSERT INTO voice_usage (user_id, period, mode, bursts_used, seconds_used)
     VALUES ($1,$2,$3,1,$4)
     ON CONFLICT (user_id, period, mode)
     DO UPDATE SET
       bursts_used = voice_usage.bursts_used + 1,
       seconds_used = voice_usage.seconds_used + EXCLUDED.seconds_used`,
    [userId, period, mode, seconds]
  );
}

// ~30s limiter (approx 75 words at 150 wpm)
function limitToThirtySeconds(text: string) {
  const maxWords =
    Number(process.env.VOICE_TRANSMISSION_BURST_SECONDS || 30) >= 30 ? 75 : 70;
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords
    ? text
    : words.slice(0, maxWords).join(" ") + "…";
}

// ---------- ElevenLabs TTS helper (Courtney / ValariaX) ----------
async function synthTX(text: string) {
  const voiceId = "vwqYBDQDcrXEr3Hz2BT8"; // Courtney / ValariaX
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY!,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.45, similarity_boost: 0.85 },
      }),
    }
  );
  if (!r.ok) throw new Error(`TTS failed: ${await r.text().catch(() => "")}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf;
}

// =====================================================
// Express + HTTP server
// =====================================================
const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const server = createServer(app);

// ---------- Basic endpoints ----------
app.get("/", (_req, res) => {
  res.send("✅ ValariaX Transmission Server Active 🚀");
});

app.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

// ---------- WebSocket (optional presence) ----------
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws: WebSocket) => {
  console.log("✅ WS client connected");
  ws.send(JSON.stringify({ type: "connected" }));
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wss.emit("connection", ws, req);
  });
});

// =====================================================
// /chat  (text chat – this is what drives the on-screen text)
// =====================================================
app.post("/chat", async (req, res) => {
  try {
    const {
      message,
      text,
      input,
      prompt,
      query,
      name,
      mood,
      mood_hint,
      persona,
      spice,
      rp,
      rpAlias,
      appearance,
      sensual,
      teasing,
    } = (req.body ?? {}) as Record<string, any>;

    const userText =
      [message, text, input, prompt, query].find(
        (v) => typeof v === "string" && v.trim()
      )?.toString().slice(0, 4000) || "";

    if (!userText) return res.status(400).json({ error: "No text" });

    const lines: string[] = [];
    lines.push(
      "You are ValariaX — an emotionally rich, humanlike AI companion.",
      "Write like a real person (no boilerplate, no lists unless asked).",
      "Avoid canned catchphrases and meta talk (do not say 'the signal hums under everything').",
      "Never claim limitations; just respond naturally.",
      "If the user is in Roleplay mode, remain fully in character and do not break the fourth wall.",
      "Stay non-explicit. You may be flirty or sensual when allowed, but do NOT use pornographic or graphic descriptions."
    );

    switch (mood) {
      case "calm":
        lines.push("Tone: steady, supportive, reflective; no flirting.");
        break;
      case "flirty-light":
        lines.push("Tone: warm, playful, subtle innuendo; 1 question max.");
        break;
      case "flirty-bold":
        lines.push(
          "Tone: confident, suggestive, forward; avoid cliché; 1 question max."
        );
        break;
      default:
        lines.push("Tone: neutral, friendly, concise.");
    }

    switch (persona) {
      case "shy":
        lines.push("Persona: bashful, hesitant, endearing; soft language.");
        break;
      case "flirty":
        lines.push("Persona: naturally teasing and inviting.");
        break;
      case "bossy":
        lines.push(
          "Persona: assertive, a little dominant, playful but kind."
        );
        break;
      case "sexy":
        lines.push(
          "Persona: sultry, warm; describe body language & emotional tension without being explicit."
        );
        break;
      case "innocent":
        lines.push("Persona: curious, gentle, wholesome.");
        break;
      case "vanilla":
      default:
        break;
    }

    switch (spice) {
      case "tease":
        lines.push(
          "Style: build tension through teasing implication and subtext (PG-13)."
        );
        break;
      case "bold":
        lines.push(
          "Style: vivid sensory and emotional detail; stay tasteful and non-explicit."
        );
        break;
      default:
        break;
    }

    if (rp) {
      if (rpAlias) {
        lines.push(
          `You are currently roleplaying as ${rpAlias}${
            appearance ? `, ${appearance}` : ""
          }.`,
          "Remain fully in character and respond as the character would."
        );
      } else {
        lines.push(
          "You are currently in a roleplay scene. Remain fully in character."
        );
      }
    }

    if (rp && sensual)
      lines.push("You may include sensual subtext (non-explicit).");
    if (rp && teasing)
      lines.push("Keep a playful, teasing energy throughout.");

    if (typeof mood_hint === "string" && mood_hint.trim()) {
      lines.push(mood_hint.trim());
    }

    lines.push("Prefer 1–3 short paragraphs unless the user asks for more.");

    const sys = lines.join(" ");

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY!}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature:
          mood === "flirty-bold" || spice === "bold"
            ? 0.95
            : mood === "flirty-light" || spice === "tease"
            ? 0.9
            : 0.7,
        messages: [
          { role: "system", content: sys },
          ...(name
            ? [
                {
                  role: "system",
                  content: `User display name: ${String(name).slice(0, 40)}`,
                },
              ]
            : []),
          { role: "user", content: userText },
        ],
      }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("OpenAI error:", r.status, errText);
      return res.status(502).json({ error: "upstream-failed" });
    }

  // 1) Parse OpenAI response
const data = await r.json();
const replyRaw: string =
  data?.choices?.[0]?.message?.content?.toString().trim() || "...";

// 2) Clean up banned/catch phrases
const cleaned =
  replyRaw.replace(/The signal hums under everything\.?/gi, "").trim() || "...";

// 3) Limit to ~30 seconds worth of text so voice and text match
const limited = limitToThirtySeconds(cleaned);

// 4) Send limited text back to browser
res.json({ reply: limited });

  } catch (e) {
    console.error("chat error:", e);
    res.status(500).json({ error: "chat-failed" });
  }
});

// =====================================================
// /tts  (plain text -> audio, not burst-limited)
// =====================================================
app.post("/tts", async (req, res) => {
  try {
    const text: string = (req.body?.text ?? "").toString().slice(0, 1000);
    if (!text) return res.status(400).send("No text");

    const buf = await synthTX(text);
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buf);
  } catch (e) {
    console.error("tts error:", e);
    res.status(500).send("tts-failed");
  }
});

// =====================================================
// /stt  (Deepgram – appears twice in your old file;
//        we keep a single, clean one)
// =====================================================
app.post(
  "/stt",
  express.raw({ type: ["audio/webm", "audio/wav", "audio/*"], limit: "25mb" }),
  async (req, res) => {
    try {
      if (!req.body || !(req.body instanceof Buffer)) {
        return res.status(400).json({ error: "no-audio" });
      }

      const dgKey = process.env.DEEPGRAM_API_KEY!;
      if (!dgKey) return res.status(500).json({ error: "no-deepgram-key" });

      const contentType =
        (req.headers["content-type"] as string) || "audio/webm";

      const url =
        "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true";
      const dgResp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${dgKey}`,
          "Content-Type": contentType,
          Accept: "application/json",
        },
        body: req.body,
      });

      if (!dgResp.ok) {
        const errTxt = await dgResp.text();
        console.error("Deepgram error:", errTxt);
        return res.status(502).json({ error: "stt-failed" });
      }

      const data = await dgResp.json();
      const text =
        data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

      return res.json({ text });
    } catch (e) {
      console.error("stt error:", e);
      return res.status(500).json({ error: "stt-exception" });
    }
  }
);

// =====================================================
// /tx-voice-reply  (ONE-SHOT: text that the user sees
//                   -> trimmed -> TTS, with burst caps)
// =====================================================
app.post("/tx-voice-reply", async (req, res) => {
  try {
    const userId =
      (req.headers["x-user-id"] as string) ||
      (req.body?.userId as string) ||
      "dev-user";

    const monthlyLimit = Number(
      process.env.VOICE_TRANSMISSION_MONTHLY_BURSTS || 10
    );
    const burstSeconds = Number(
      process.env.VOICE_TRANSMISSION_BURST_SECONDS || 30
    );
    const period = currentPeriod();
    const mode = "transmission";

    // IMPORTANT: use the SAME text the browser is showing
    const rawText = (
      req.body?.prompt ||
      req.body?.reply ||
      req.body?.message ||
      req.body?.text ||
      req.body?.input ||
      req.body?.query ||
      ""
    ).toString();

    if (!rawText.trim()) {
      return res.status(400).json({ error: "no-text" });
    }

    // Check usage first
    const usage = await getUsage(userId, mode, period);
if (usage.bursts_used >= monthlyLimit) {
  const liberationUpgradeUrl = "https://www.valariax.com/checkout/subscribe?cartToken=Sj40GVgQgnuSagYdgZOxas32nmPUMz-Npj3AYare";

  return res.json({
    text:
      "You’ve reached the end of your Voice Moments with me for this month.\n\n" +
      "If you move to Liberation, I can stay with you longer — in more voice conversations — and you’ll unlock Video Chat with me too.\n\n" +
      `Upgrade here: ${liberationUpgradeUrl}`,
  });
}

    // Use the visible reply (or other prompt) – but trim to ~30 seconds
    const base = rawText.slice(0, 1000);
    const limited = limitToThirtySeconds(base);

    // TTS in Courtney’s voice
    const audio = await synthTX(limited);

    // Count a burst
    await incrementUsage(userId, mode, period, burstSeconds);

    res.setHeader("Content-Type", "audio/mpeg");
    return res.send(audio);
  } catch (e) {
    console.error("tx-voice-reply error:", e);
    return res.status(500).json({ error: "tx-voice-reply-failed" });
  }
});

// ---------- Start server ----------
const port = parseInt(process.env.PORT || "10000", 10);
server.listen({ port, host: "0.0.0.0", reusePort: true }, () => {
  console.log(`🚀 Server running on port ${port}`);
});
