// embedded in daemon index
import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "HEALTHY",
        uptimeSeconds: process.uptime(),
        timestamp: new Date().toISOString(),
        service: "segmento-event-bridge",
      })
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(process.env.PORT || 8080, () => {
  console.log(`[HealthCheck] Diagnostic server listening on port ${process.env.PORT || 8080}`);
});