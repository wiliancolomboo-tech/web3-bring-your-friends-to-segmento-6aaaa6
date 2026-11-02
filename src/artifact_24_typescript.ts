import http from "http";
import { SegmentoTelemetryService } from "./service";
import fs from "fs";

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, async () => {
  console.log(`[HTTP] Healthcheck server listening on port ${PORT}`);
  const idl = JSON.parse(fs.readFileSync("./target/idl/segmento_referral.json", "utf8"));
  const telemetry = new SegmentoTelemetryService();
  await telemetry.startEventListener(idl);
});