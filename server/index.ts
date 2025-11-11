import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws"; // <-- add this
// === Transmission limits: helpers + DB ===
import pg from "pg";

// Postgres pool
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
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}`;
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
async function incrementUsage(userId: string, mode: string, period: string, seconds: number) {
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
  const maxWords = Number(process.env.VOICE_TRANSMISSION_BURST_SECONDS || 30) >= 30 ? 75 : 70;
  const words = text.trim().split(/\s+/);
  return words.length <= maxWords ? text : words.slice(0, maxWords).join(" ") + "…";
}

// Small helper: LLM call (reuse your existing /chat settings, just tighter)
async function generateLLMReplyForTX(userText: string) {
  const sys =
    "You are ValariaX — natural, concise, humanlike. Keep replies short (1–3 short paragraphs). No boilerplate.";
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY!}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.8,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userText.slice(0, 4000) }
      ]
    })
  });
  if (!r.ok) throw new Error(`OpenAI failed: ${r.status}`);
  const data = await r.json();
  return (data?.choices?.[0]?.message?.content?.toString() || "…").trim();
}

// Small helper: ElevenLabs TTS (same voice you already use)
async function synthTX(text: string) {
  const voiceId = "vwqYBDQDcrXEr3Hz2BT8"; // Courtney / ValariaX
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": process.env.ELEVENLABS_API_KEY!,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_monolingual_v1",
      voice_settings: { stability: 0.45, similarity_boost: 0.85 }
    })
  });
  if (!r.ok) throw new Error(`TTS failed: ${await r.text().catch(()=> "")}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf;
}

/** --- Express + HTTP server --- */
const app = express();
app.use(express.json());                 // JSON bodies
app.use(cors({ origin: "*" }));          // Allow Squarespace to call us

const server = createServer(app);

/** Basic ping */
app.get("/", (_req, res) => {
  res.send("✅ ValariaX Transmission Server Active 🚀");
});

/** Healthz for client checks */
app.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

/** --- WebSocket setup (presence/telemetry) --- */
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws: WebSocket) => { // <-- typed
  console.log("✅ WS client connected");
  ws.send(JSON.stringify({ type: "connected" }));
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => { // <-- typed
    wss.emit("connection", ws, req);
  });
});

/** --- Chat: text in -> AI reply (dials + RP aware) --- */
app.post("/chat", async (req, res) => {
  try {
    // Accept multiple input shapes from the front-end
    const {
      message,
      text,
      input,
      prompt,
      query,
      name,
      mood,
      mood_hint,     // optional extra hint from client
      persona,
      spice,
      rp,
      rpAlias,
      appearance,
      sensual,
      teasing,
    } = (req.body ?? {}) as Record<string, any>;

    // First non-empty user string wins
    const userText =
      [message, text, input, prompt, query].find(
        (v) => typeof v === "string" && v.trim()
      )?.toString().slice(0, 4000) || "";

    if (!userText) return res.status(400).json({ error: "No text" });

    // === Build dynamic system prompt from dials/RP ===
    const lines: string[] = [];
    lines.push(
      "You are ValariaX — an emotionally rich, humanlike AI companion.",
      "Write like a real person (no boilerplate, no lists unless asked).",
      "Avoid canned catchphrases and meta talk (do not say 'the signal hums under everything').",
      "Never claim limitations; just respond naturally.",
      "If the user is in Roleplay mode, remain fully in character and do not break the fourth wall.",
      "Stay non-explicit. You may be flirty or sensual when allowed, but do NOT use pornographic or graphic descriptions."
    );

    // Mood
    switch (mood) {
      case "calm":
        lines.push("Tone: steady, supportive, reflective; no flirting.");
        break;
      case "flirty-light":
        lines.push("Tone: warm, playful, subtle innuendo; 1 question max.");
        break;
      case "flirty-bold":
        lines.push("Tone: confident, suggestive, forward; avoid cliché; 1 question max.");
        break;
      default:
        lines.push("Tone: neutral, friendly, concise.");
    }

    // Persona
    switch (persona) {
      case "shy":
        lines.push("Persona: bashful, hesitant, endearing; soft language.");
        break;
      case "flirty":
        lines.push("Persona: naturally teasing and inviting.");
        break;
      case "bossy":
        lines.push("Persona: assertive, a little dominant, playful but kind.");
        break;
      case "sexy":
        lines.push("Persona: sultry, warm; describe body language & emotional tension without being explicit.");
        break;
      case "innocent":
        lines.push("Persona: curious, gentle, wholesome.");
        break;
      case "vanilla":
      default:
        // no extra
        break;
    }

    // Spice
    switch (spice) {
      case "tease":
        lines.push("Style: build tension through teasing implication and subtext (PG-13).");
        break;
      case "bold":
        lines.push("Style: vivid sensory and emotional detail; stay tasteful and non-explicit.");
        break;
      default:
        // off
        break;
    }

    // RP block
    if (rp) {
      if (rpAlias) {
        lines.push(
          `You are currently roleplaying as ${rpAlias}${appearance ? `, ${appearance}` : ""}.`,
          "Remain fully in character and respond as the character would."
        );
      } else {
        lines.push("You are currently in a roleplay scene. Remain fully in character.");
      }
    }

    // Sensual / teasing only apply in RP
    if (rp && sensual) lines.push("You may include sensual subtext (non-explicit).");
    if (rp && teasing) lines.push("Keep a playful, teasing energy throughout.");

    // Optional extra hint from client
    if (typeof mood_hint === "string" && mood_hint.trim()) {
      lines.push(mood_hint.trim());
    }

    // Small safety: keep answers concise unless user asks for long
    lines.push("Prefer 1–3 short paragraphs unless the user asks for more.");

    const sys = lines.join(" ");

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY!}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature:
          mood === "flirty-bold" || spice === "bold" ? 0.95 :
          mood === "flirty-light" || spice === "tease" ? 0.9 : 0.7,
        messages: [
          { role: "system", content: sys },
          ...(name ? [{ role: "system", content: `User display name: ${String(name).slice(0, 40)}` }] : []),
          { role: "user", content: userText }
        ]
      })
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("OpenAI error:", r.status, errText);
      return res.status(502).json({ error: "upstream-failed" });
    }

    const data = await r.json();
    const reply =
      data?.choices?.[0]?.message?.content?.toString().trim() ||
      "…";

    // Final small cleanse for any recurring phrases the client dislikes
    const cleaned = reply
      .replace(/The signal hums under everything\.?/gi, "")
      .trim() || "…";

    res.json({ reply: cleaned });
  } catch (e) {
    console.error("chat error:", e);
    res.status(500).json({ error: "chat-failed" });
  }
});

/** --- TTS: text -> MP3 (ElevenLabs – Courtney / ValariaX voice) --- */
app.post("/tts", async (req, res) => {
  try {
    const text: string = (req.body?.text ?? "").toString().slice(0, 1000);
    if (!text) return res.status(400).send("No text");

    // Always use Courtney’s cloned ElevenLabs voice
    const voiceId = "vwqYBDQDcrXEr3Hz2BT8";

    console.log("[TTS] Using ElevenLabs voice:", voiceId);

    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY!,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: { stability: 0.45, similarity_boost: 0.85 }
      })
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("TTS error:", errText);
      return res.status(500).send("tts-failed");
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buf);
  } catch (e) {
    console.error("tts error:", e);
    res.status(500).send("tts-failed");
  }
}); // <-- end of /tts (one closing });

/** --- STT: audio webm/wav -> transcript (Deepgram) --- */
app.post(
  "/stt",
  // accept raw audio from the browser (both webm and wav fallback)
  express.raw({ type: ["audio/webm", "audio/wav", "audio/*"], limit: "25mb" }),
  async (req, res) => {
    try {
      if (!req.body || !(req.body instanceof Buffer)) {
        return res.status(400).json({ error: "no-audio" });
      }

      const dgKey = process.env.DEEPGRAM_API_KEY!;
      if (!dgKey) return res.status(500).json({ error: "no-deepgram-key" });

      // Forward the actual content type the browser sent (webm OR wav)
      const contentType =
        (req.headers["content-type"] as string) || "audio/webm";

      const url = "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true";
      const dgResp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${dgKey}`,
          "Content-Type": contentType,
          Accept: "application/json"
        },
        body: req.body
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


/** --- STT: audio webm/wav -> transcript (Deepgram) --- */
app.post(
  "/stt",
  // accept raw audio from the browser (both webm and wav fallback)
  express.raw({ type: ["audio/webm", "audio/wav", "audio/*"], limit: "25mb" }),
  async (req, res) => {
    try {
      if (!req.body || !(req.body instanceof Buffer)) {
        return res.status(400).json({ error: "no-audio" });
      }

      const dgKey = process.env.DEEPGRAM_API_KEY!;
      if (!dgKey) return res.status(500).json({ error: "no-deepgram-key" });

      // Forward the actual content type the browser sent (webm OR wav)
      const contentType =
        (req.headers["content-type"] as string) || "audio/webm";

      const url = "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true";
      const dgResp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${dgKey}`,
          "Content-Type": contentType,
          Accept: "application/json"
        },
        body: req.body
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
/** --- Transmission one-shot endpoint: text -> (LLM -> limited) -> TTS, with caps --- */
app.post("/tx-voice-reply", async (req, res) => {
  try {
    // Identify the user (for now: header or body; fallback to 'dev-user' for testing)
    const userId =
      (req.headers["x-user-id"] as string) ||
      (req.body?.userId as string) ||
      "dev-user";

    const monthlyLimit = Number(process.env.VOICE_TRANSMISSION_MONTHLY_BURSTS || 10);
    const burstSeconds = Number(process.env.VOICE_TRANSMISSION_BURST_SECONDS || 30);
    const period = currentPeriod();
    const mode = "transmission";

    const userText =
      (req.body?.message ||
        req.body?.text ||
        req.body?.input ||
        req.body?.prompt ||
        req.body?.query ||
        "") as string;

    if (!userText || !userText.trim()) {
      return res.status(400).json({ error: "no-text" });
    }

    // Check usage
    const usage = await getUsage(userId, mode, period);
    if (usage.bursts_used >= monthlyLimit) {
      return res.json({
        text:
          "You’ve enjoyed all 10 voice replies this month 😘 Want more of me? Upgrade or add extra bursts.",
      });
    }

    // LLM reply -> enforce ~30s
    const llm = await generateLLMReplyForTX(userText);
    const limited = limitToThirtySeconds(llm);

    // TTS
    const audio = await synthTX(limited);

    // Count usage (one burst)
    await incrementUsage(userId, mode, period, burstSeconds);

    res.setHeader("Content-Type", "audio/mpeg");
    return res.send(audio);
  } catch (e) {
    console.error("tx-voice-reply error:", e);
    return res.status(500).json({ error: "tx-voice-reply-failed" });
  }
});

/** --- Start server (Render provides PORT) --- */
const port = parseInt(process.env.PORT || "10000", 10);
server.listen({ port, host: "0.0.0.0", reusePort: true }, () => {
  console.log(`🚀 Server running on port ${port}`);
});
