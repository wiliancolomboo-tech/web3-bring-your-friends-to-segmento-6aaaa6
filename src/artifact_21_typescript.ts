import { Connection, PublicKey } from "@solana/web3.js";
import { CONFIG } from "./config";
import { WebhookService } from "./services/webhookService";
import { EmailService } from "./services/emailService";
import winston from "winston";

const logger = winston.createLogger({
  level: "info",
  transports: [new winston.transports.Console()],
});

export class SegmentoIndexer {
  private connection: Connection;
  private programId: PublicKey;

  constructor() {
    this.connection = new Connection(CONFIG.SOLANA_RPC_URL, {
      wsEndpoint: CONFIG.SOLANA_WS_URL,
      commitment: "confirmed",
    });
    this.programId = new PublicKey(CONFIG.PROGRAM_ID);
  }

  public async start(): Promise<void> {
    logger.info(`[SegmentoIndexer] Listening to program events for ID: ${this.programId.toBase58()}`);

    this.connection.onLogs(
      this.programId,
      async (logs) => {
        if (logs.err) return;

        for (const log of logs.logs) {
          if (log.includes("ReferralBoundEvent")) {
            logger.info(`[INDEXER] ReferralBoundEvent Detected: ${logs.signature}`);
            await WebhookService.dispatchSlackAlert(
              "🚀 New Segmento Referral Bound!",
              "A new friend was bound on-chain to an advocate.",
              { signature: logs.signature }
            );
          } else if (log.includes("RewardClaimedEvent")) {
            logger.info(`[INDEXER] RewardClaimedEvent Detected: ${logs.signature}`);
            await WebhookService.dispatchSlackAlert(
              "💰 Referral Milestone Unlocked & Reward Paid!",
              "Reward tokens have been successfully withdrawn from the escrow vault.",
              { signature: logs.signature }
            );
            // Example trigger to Resend email flow
            await EmailService.sendReferralSuccessEmail(
              "alice@example.com",
              "Friend-On-Solana",
              50
            );
          }
        }
      },
      "confirmed"
    );
  }
}