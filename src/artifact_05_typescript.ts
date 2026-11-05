import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Resend } from "resend";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const PROGRAM_ID = new PublicKey(process.env.SEGMENTO_PROGRAM_ID || "SegmXyZ9oQGzK4rN1aWqT7uE3jVpB5mF8sC2dD6hA1B");
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_000000000000000000000000";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

const resend = new Resend(RESEND_API_KEY);

interface RefereeBoundPayload {
  referee: string;
  referrer: string;
  timestamp: number;
  signature: string;
}

interface MilestoneCompletedPayload {
  referee: string;
  referrer: string;
  milestoneId: number;
  actionVolumeLamports: number;
  rewardPayoutLamports: number;
  timestamp: number;
  signature: string;
}

export class SegmentoGrowthAgent {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(RPC_URL, {
      commitment: "confirmed",
      wsEndpoint: RPC_URL.replace("https://", "wss://").replace("http://", "ws://"),
    });
  }

  public async start(): Promise<void> {
    console.log("=====================================================");
    console.log("🚀 SEGMENTO GROWTH AGENT INITIALIZED");
    console.log(`📡 Listening to Solana Program: ${PROGRAM_ID.toBase58()}`);
    console.log("=====================================================");

    this.connection.onLogs(
      PROGRAM_ID,
      async (logs, ctx) => {
        if (logs.err) return;

        for (const log of logs.logs) {
          if (log.includes("RefereeBoundEvent")) {
            console.log(`[EVENT] RefereeBound detected in tx: ${logs.signature}`);
            await this.handleRefereeBound({
              referee: "Detected via log",
              referrer: "Detected via log",
              timestamp: Date.now(),
              signature: logs.signature,
            });
          }

          if (log.includes("MilestoneCompletedEvent")) {
            console.log(`[EVENT] MilestoneCompleted detected in tx: ${logs.signature}`);
            await this.handleMilestoneCompleted({
              referee: "RefereePublicKey",
              referrer: "ReferrerPublicKey",
              milestoneId: 1,
              actionVolumeLamports: 1_000_000_000,
              rewardPayoutLamports: 50_000_000,
              timestamp: Date.now(),
              signature: logs.signature,
            });
          }
        }
      },
      "confirmed"
    );
  }

  public async handleRefereeBound(payload: RefereeBoundPayload): Promise<void> {
    const explorerUrl = `https://explorer.solana.com/tx/${payload.signature}?cluster=devnet`;
    const message = `🎉 **New Friend Joined Segmento!**\n• Referee: \`${payload.referee}\`\n• Referrer: \`${payload.referrer}\`\n• [View on Solana Explorer](${explorerUrl})`;

    await this.dispatchDiscord(message);
    await this.dispatchSlack(`New Friend Joined Segmento! Referrer: ${payload.referrer}`);
  }

  public async handleMilestoneCompleted(payload: MilestoneCompletedPayload): Promise<void> {
    const solReward = (payload.rewardPayoutLamports / 1e9).toFixed(4);
    const explorerUrl = `https://explorer.solana.com/tx/${payload.signature}?cluster=devnet`;

    const message = `💰 **Segmento Referral Commission Settled!**\n• Referrer Reward: **${solReward} SOL**\n• Referee: \`${payload.referee}\`\n• Milestone ID: #${payload.milestoneId}\n• [Proof of Payment](${explorerUrl})`;

    await this.dispatchDiscord(message);
    await this.dispatchSlack(`Segmento Reward Distributed: ${solReward} SOL to ${payload.referrer}`);

    // Enterprise Resend Transactional Email
    if (process.env.RESEND_API_KEY && process.env.ALERT_EMAIL_RECIPIENT) {
      try {
        await resend.emails.send({
          from: "Segmento Growth <notifications@segmento.io>",
          to: process.env.ALERT_EMAIL_RECIPIENT,
          subject: `💰 Your friend earned you ${solReward} SOL on Segmento!`,
          html: `
            <div style="font-family: Arial, sans-serif; background-color: #0b0e14; color: #ffffff; padding: 24px; border-radius: 8px;">
              <h2 style="color: #14f195;">Friend Activated on Segmento!</h2>
              <p>Your referral milestone has been verified and settled on Solana.</p>
              <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
                <tr><td style="color: #99a1b3;">Earned Commission:</td><td><strong>${solReward} SOL</strong></td></tr>
                <tr><td style="color: #99a1b3;">Referee:</td><td><code>${payload.referee}</code></td></tr>
                <tr><td style="color: #99a1b3;">Transaction:</td><td><a href="${explorerUrl}" style="color: #14f195;">View on Solana Explorer</a></td></tr>
              </table>
              <p style="margin-top: 24px; font-size: 12px; color: #606778;">Segmento Autonomic Growth Protocol</p>
            </div>
          `,
        });
        console.log(`[RESEND] Notification email sent to ${process.env.ALERT_EMAIL_RECIPIENT}`);
      } catch (err: any) {
        console.error(`[RESEND ERROR] Failed to send email: ${err.message}`);
      }
    }
  }

  private async dispatchDiscord(content: string): Promise<void> {
    if (!DISCORD_WEBHOOK_URL) return;
    try {
      await axios.post(DISCORD_WEBHOOK_URL, { content });
    } catch (err: any) {
      console.error(`[DISCORD WEBHOOK ERROR] ${err.message}`);
    }
  }

  private async dispatchSlack(text: string): Promise<void> {
    if (!SLACK_WEBHOOK_URL) return;
    try {
      await axios.post(SLACK_WEBHOOK_URL, { text });
    } catch (err: any) {
      console.error(`[SLACK WEBHOOK ERROR] ${err.message}`);
    }
  }
}

// Auto-run if executed directly
if (require.main === module) {
  const agent = new SegmentoGrowthAgent();
  agent.start().catch((err) => {
    console.error("Agent encountered fatal error:", err);
    process.exit(1);
  });
}