// Proxy between the Android app and a real OpenClaw Gateway.
// MODE=flaky: after the Gateway answers `connect` successfully, close the socket (like a Gateway that restarts in a loop).
// MODE=normal: forward everything. Used to show that a real drop still reconnects at once.
// Logs one line per `connect` request, with a timestamp, to LOG.
const { WebSocketServer, WebSocket } = require("C:/oc-a/node_modules/ws");
const fs = require("fs");
const LISTEN = Number(process.env.LISTEN || 18790);
const UPSTREAM = process.env.UPSTREAM || "ws://127.0.0.1:18789";
const MODE = process.env.MODE || "flaky";
const LOG = process.env.LOG || "proxy.log";
const t0 = Date.now();
let connects = 0;
const log = (m) => fs.appendFileSync(LOG, `${((Date.now() - t0) / 1000).toFixed(2)}s ${m}\n`);
const wss = new WebSocketServer({ port: LISTEN });
log(`proxy up mode=${MODE} listen=${LISTEN} upstream=${UPSTREAM}`);
wss.on("connection", (client, req) => {
  log(`socket open (${req.url})`);
  const up = new WebSocket(UPSTREAM, { headers: { origin: req.headers.origin || "" } });
  const queue = [];
  const connectIds = new Set();
  client.on("message", (data, isBinary) => {
    const text = isBinary ? null : data.toString();
    try {
      const f = JSON.parse(text);
      if (f.type === "req" && f.method === "connect") {
        connects++;
        connectIds.add(f.id);
        log(`CONNECT request #${connects}`);
      }
    } catch {}
    if (up.readyState === WebSocket.OPEN) up.send(data, { binary: isBinary });
    else queue.push([data, isBinary]);
  });
  up.on("open", () => queue.splice(0).forEach(([d, b]) => up.send(d, { binary: b })));
  up.on("message", (data, isBinary) => {
    client.send(data, { binary: isBinary });
    if (MODE === "drop15" && !isBinary) {
      // A healthy connection that really drops after 15 s: the app should reconnect at once.
      try {
        const f = JSON.parse(data.toString());
        if (f.type === "res" && connectIds.has(f.id) && f.ok) {
          log("hello sent to app; will drop the socket in 15 s");
          setTimeout(() => { log("dropping healthy socket now"); client.close(1012, "service restart"); }, 15000);
        }
      } catch {}
    }
    if (MODE === "flaky" && !isBinary) {
      try {
        const f = JSON.parse(data.toString());
        if (f.type === "res" && connectIds.has(f.id) && f.ok) {
          log("hello sent to app; closing socket (1012)");
          setTimeout(() => client.close(1012, "service restart"), 20);
        }
      } catch {}
    }
  });
  client.on("close", () => { log("socket closed"); up.close(); });
  up.on("close", () => client.close());
  up.on("error", (e) => log(`upstream error ${e.message}`));
  client.on("error", () => {});
});
