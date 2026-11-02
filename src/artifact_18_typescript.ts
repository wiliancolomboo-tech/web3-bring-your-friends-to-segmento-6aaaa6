import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { CONFIG } from "./config";
import { EnterpriseNotificationHub } from "./services/notifier";
import winston from "winston";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level}: ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

async function main() {
  logger.info("Initializing Segmento Nexus Event Daemon...");
  const connection = new Connection(CONFIG.SOLANA_RPC_URL, {
    wsEndpoint: CONFIG.SOLANA_WSS_URL,
    commitment: "confirmed",
  });

  const dummyWallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, dummyWallet, { commitment: "confirmed" });
  const programId = new PublicKey(CONFIG.PROGRAM_ID);

  logger.info(`Connected to RPC. Subscribing to Program Logs for: ${programId.toBase58()}`);

  connection.onLogs(
    programId,
    async (logs, ctx) => {
      try {
        for (const line of logs.logs) {
          if (line.includes("ReferralBound")) {
            logger.info(`ReferralBound detected! Signature: ${logs.signature}`);
            await EnterpriseNotificationHub.sendReferralAlert(
              "Refreshed Account",
              "Registered Referrer",
              logs.signature
            );
          } else if (line.includes("RewardAccrued")) {
            logger.info(`RewardAccrued logged. Signature: ${logs.signature}`);
          }
        }
      } catch (err: any) {
        logger.error(`Error processing log event: ${err.message}`);
      }
    },
    "confirmed"
  );

  // Keep alive
  setInterval(() => {
    logger.info("Daemon heartbeat: Listening for Solana runtime events...");
  }, 30000);
}

main().catch((err) => {
  logger.error(`Fatal crash in event subscriber: ${err.message}`);
  process.exit(1);
});