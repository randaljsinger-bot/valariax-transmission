import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";

/** --- Express + HTTP server --- */
const app = express();
app.use(express.json());              // JSON bodies
app.use(cors({ origin: "*"}));        // Allow Squarespace to call us

const server = createServer(app);

/** Basic ping */
app.get("/", (_req, res) => {
  res.send("✅ ValariaX Transmission Server Active 🚀");
});

/** --- WebSocket setup (presence/telemetry) --- */
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => {
  console.log("✅ WS client connected");
  ws.send(JSON.stringify({ type: "connected" }));
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

/** --- Chat: text in -> AI reply --- */
app.post("/chat", async (req, res) => {
  try {
    const userText: string = (req.body?.text ?? "").toString().slice(0, 2000);
    if (!userText) return res.status(400).json({ error: "No text" });

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY!}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are ValariaX — warm, confident, helpful, concise." },
          { role: "user", content: userText }
        ],
        temperature: 0.7
      })
    });

    const data = await r.json();
    const reply =
      data?.choices?.[0]?.message?.content?.toString() ||
      "I’m here.";

    res.json({ reply });
  } catch (e) {
    console.error("chat error:", e);
    res.status(500).json({ error: "chat-failed" });
  }
});

/** --- TTS: text -> MP3 (ElevenLabs) --- */
app.post("/tts", async (req, res) => {
  try {
    const text: string = (req.body?.text ?? "").toString().slice(0, 1000);
    if (!text) return res.status(400).send("No text");

    const voiceId = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
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
        voice_settings: { stability: 0.45, similarity_boost: 0.8 }
      })
    });

    if (!r.ok) {
      const errText = await r.text();
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
});

/** --- Start server (Render provides PORT) --- */
const port = parseInt(process.env.PORT || "10000", 10);
server.listen({ port, host: "0.0.0.0", reusePort: true }, () => {
  console.log(`🚀 Server running on port ${port}`);
});
