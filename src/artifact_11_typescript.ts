import http from "http";
import { Keypair } from "@solana/web3.js";
import { SegmentoGrowthAgent } from "./agent";
import * as fs from "fs";

const PORT = process.env.PORT || 8080;

let isReady = false;

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(isReady ? 200 : 503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: isReady ? "HEALTHY" : "INITIALIZING",
        service: "segmento-growth-daemon",
        solanaCluster: process.env.SOLANA_RPC_URL || "devnet",
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[HealthCheck] Diagnostic server running on port ${PORT}`);

  try {
    const keyPath = process.env.KEYPAIR_PATH || "./keys/authority.json";
    let adminKeypair: Keypair;
    if (fs.existsSync(keyPath)) {
      adminKeypair = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")))
      );
    } else {
      adminKeypair = Keypair.generate();
      console.warn("[Warning] Running with ephemeral ephemeral keypair.");
    }

    const agent = new SegmentoGrowthAgent({
      rpcEndpoint: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
      programId: process.env.PROGRAM_ID || "SegM111111111111111111111111111111111111111",
      adminKeypair,
      resendApiKey: process.env.RESEND_API_KEY,
      discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
      segmentoApiEndpoint: process.env.SEGMENTO_API_URL,
    });

    agent.listenToProgramEvents();
    isReady = true;
    console.log("[SegmentoAgent] Daemon successfully initialized.");
  } catch (err: any) {
    console.error("[Fatal] Failed to bootstrap Segmento Agent:", err.message);
  }
});