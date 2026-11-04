// Proxy between the Android app and a real OpenClaw Gateway, for the media download proof.
// The app does the real work: it shows a file attachment in Chat, the user taps it, the app calls
// artifacts.download and downloads the file over HTTP with its OkHttp client.
// The proxy only supplies the file: it adds one assistant message with a file attachment to chat.history,
// answers artifacts.download with a ticketed URL, and serves that URL as a slow download.
//   MODE=slow : SIZE_MB megabytes at RATE_KBPS, a steady stream (takes longer than 20 s in total).
//   MODE=stall: sends 1 KB and then nothing (a stalled link). The app must give up after 20 s.
const http = require("http");
const fs = require("fs");
const { WebSocketServer, WebSocket } = require("C:/oc-a/node_modules/ws");
const LISTEN = Number(process.env.LISTEN || 18790);
const UPSTREAM = process.env.UPSTREAM || "ws://127.0.0.1:18789";
const MODE = process.env.MODE || "slow";
const SIZE = Number(process.env.SIZE_MB || 30) * 1024 * 1024;
const RATE = Number(process.env.RATE_KBPS || 1200) * 1024; // bytes per second
const LOG = process.env.LOG || "media-proxy.log";
const t0 = Date.now();
const log = (m) => fs.appendFileSync(LOG, `${((Date.now() - t0) / 1000).toFixed(2)}s ${m}\n`);
const UUID = "44444444-4444-4444-8444-444444444444";
const ARTIFACT = `artifact_managed_media_${UUID}`;
const PATH = `/api/chat/media/outgoing/main/${UUID}/full`;

const server = http.createServer((req, res) => {
  if (!req.url.startsWith("/api/chat/media/outgoing/")) { res.statusCode = 404; return res.end(); }
  log(`HTTP GET ${req.url} (mode=${MODE})`);
  res.writeHead(200, { "Content-Type": "application/pdf", ...(MODE === "slow" ? { "Content-Length": String(SIZE) } : { "Content-Length": String(SIZE) }) });
  if (MODE === "stall") {
    res.write(Buffer.alloc(1024));
    log("sent 1 KB, now silent");
    req.on("close", () => log("app closed the download connection"));
    return;
  }
  const tick = 100;
  const chunk = Buffer.alloc(Math.floor((RATE * tick) / 1000), 0x25);
  let sent = 0;
  const timer = setInterval(() => {
    const n = Math.min(chunk.length, SIZE - sent);
    res.write(chunk.subarray(0, n));
    sent += n;
    if (sent >= SIZE) { clearInterval(timer); res.end(); log(`finished sending ${sent} bytes`); }
  }, tick);
  req.on("close", () => { clearInterval(timer); if (sent < SIZE) log(`app closed the download connection after ${sent} bytes`); });
});
const wss = new WebSocketServer({ server });
server.listen(LISTEN, () => log(`proxy up mode=${MODE} listen=${LISTEN} size=${SIZE} rate=${RATE}B/s`));

wss.on("connection", (client) => {
  const up = new WebSocket(UPSTREAM);
  const queue = [];
  const historyIds = new Set();
  client.on("message", (data, isBinary) => {
    let f = null;
    try { f = JSON.parse(data.toString()); } catch {}
    if (f && f.type === "req") {
      if (f.method === "artifacts.download") {
        log(`artifacts.download ${f.params && f.params.artifactId} answered by proxy`);
        client.send(JSON.stringify({ type: "res", id: f.id, ok: true, payload: {
          artifact: { type: "file", mimeType: "application/pdf" }, url: `${PATH}?mediaTicket=proof-ticket` } }));
        return;
      }
      if (f.method === "chat.history") historyIds.add(f.id);
    }
    if (up.readyState === WebSocket.OPEN) up.send(data, { binary: isBinary }); else queue.push([data, isBinary]);
  });
  up.on("open", () => queue.splice(0).forEach(([d, b]) => up.send(d, { binary: b })));
  up.on("message", (data, isBinary) => {
    if (!isBinary) {
      try {
        const f = JSON.parse(data.toString());
        if (f.type === "res" && historyIds.has(f.id) && f.ok && f.payload && Array.isArray(f.payload.messages)) {
          f.payload.messages.push({
            role: "assistant", timestamp: Date.now(),
            content: [
              { type: "text", text: "Here is the file you asked for (30 MB)." },
              { type: "file", artifactId: ARTIFACT, fileName: "big-report.pdf", mimeType: "application/pdf", sizeBytes: SIZE },
            ],
          });
          log("added a file attachment message to chat.history");
          return client.send(JSON.stringify(f));
        }
      } catch {}
    }
    client.send(data, { binary: isBinary });
  });
  client.on("close", () => up.close());
  up.on("close", () => client.close());
  up.on("error", (e) => log(`upstream error ${e.message}`));
  client.on("error", () => {});
});
