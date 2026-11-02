import http from "http";

const HEALTH_PORT = process.env.HEALTH_PORT || 8080;

export function startHealthServer(isHealthy: () => boolean) {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      if (isHealthy()) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "HEALTHY", timestamp: new Date().toISOString() }));
      } else {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "UNHEALTHY", reason: "RPC_DISCONNECTED" }));
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(HEALTH_PORT, () => {
    console.log(`[HEALTH] Healthcheck probe listening on port ${HEALTH_PORT}`);
  });
}