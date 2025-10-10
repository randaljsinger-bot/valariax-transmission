import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.json());

const server = createServer(app);

// Basic test route
app.get("/", (_req, res) => {
  res.send("✅ ValariaX Transmission Server Active 🚀");
});

// --- WebSocket setup ---
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

const port = parseInt(process.env.PORT || "10000", 10);
server.listen({ port, host: "0.0.0.0", reusePort: true }, () => {
  console.log(`🚀 Server running on port ${port}`);
});
