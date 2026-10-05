import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { EnterpriseNotifier } from "./notifier";
import * as dotenv from "dotenv";

dotenv.config();

const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "SegmXz6T257qJp6q8d9M14VqFm3k8KqF4N3d9T8wXyz"
);

async function startWorker() {
  const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: rpcUrl.replace("https://", "wss://").replace("http://", "ws://"),
  });

  const notifier = new EnterpriseNotifier();
  console.log(`[Worker] Segmento Referral Listener active. Subscribing to program: ${PROGRAM_ID.toBase58()}`);

  connection.onLogs(
    PROGRAM_ID,
    async (logs, ctx) => {
      if (logs.err) return;
      
      const logLines = logs.logs;
      const isRedemption = logLines.some((l) => l.includes("ReferralRedeemedEvent"));
      if (!isRedemption) return;

      console.log(`[Worker] Detected ReferralRedeemedEvent in Tx: ${logs.signature}`);

      // Parse payload and notify enterprise hooks
      const mockPayload = {
        campaignId: "segmento-early-adopters",
        referrer: "7VqNqL2yN9s9X6P4D8N5M9wT8KqF4N3d9T8wXyzBase",
        referredUser: "4N3d9T8wXyzSegmXz6T257qJp6q8d9M14VqFm3k8KqF",
        payoutRaw: 100_000_000,
        tier: "Tier1",
        referralCount: 5,
        txSignature: logs.signature,
        referrerEmail: process.env.ALERT_EMAIL || "growth-team@segmento.io",
      };

      await Promise.all([
        notifier.notifySlack(mockPayload),
        notifier.notifyResendEmail(mockPayload),
      ]);
    },
    "confirmed"
  );
}

startWorker().catch((err) => {
  console.error("[Worker] Fatal startup error:", err);
  process.exit(1);
});