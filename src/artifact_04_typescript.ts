import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import fetch from "node-fetch";

// ==========================================
// CONFIGURATION & ENVIRONMENT
// ==========================================
interface AppConfig {
  solanaRpcUrl: string;
  solanaWsUrl: string;
  programId: string;
  resendApiKey: string;
  discordWebhookUrl: string;
  fromEmail: string;
  appBaseUrl: string;
}

const CONFIG: AppConfig = {
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  solanaWsUrl: process.env.SOLANA_WS_URL || "wss://api.devnet.solana.com",
  programId: process.env.PROGRAM_ID || "SegmXzBcxL4X6N3Zq7Q8m7Lq9uK8yT5W4vB3xM2j9Np",
  resendApiKey: process.env.RESEND_API_KEY || "re_test_000000000000000000000000",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
  fromEmail: process.env.FROM_EMAIL || "referrals@segmento.app",
  appBaseUrl: process.env.APP_BASE_URL || "https://segmento.app",
};

// ==========================================
// ENTERPRISE SERVICE INTEGRATIONS
// ==========================================
export class EnterpriseNotifier {
  private resendKey: string;
  private discordUrl: string;

  constructor(resendKey: string, discordUrl: string) {
    this.resendKey = resendKey;
    this.discordUrl = discordUrl;
  }

  async sendReferralWelcomeEmail(
    recipientEmail: string,
    referrerPubkey: string,
    inviteCode: string
  ): Promise<boolean> {
    const payload = {
      from: `Segmento Growth <${CONFIG.fromEmail}>`,
      to: [recipientEmail],
      subject: "Welcome to Segmento - Your Friend Invited You!",
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #1a1a2e; border-radius: 8px; background: #0c0d14; color: #ffffff;">
          <h1 style="color: #6366f1; margin-bottom: 16px;">Welcome to Segmento!</h1>
          <p style="font-size: 16px; line-height: 24px; color: #d1d5db;">
            You were referred by wallet <code style="background: #1f2937; padding: 2px 6px; border-radius: 4px; color: #a5b4fc;">${referrerPubkey.slice(0, 4)}...${referrerPubkey.slice(-4)}</code>.
          </p>
          <div style="background: #111827; border: 1px solid #374151; border-radius: 6px; padding: 16px; margin: 24px 0;">
            <p style="margin: 0; font-size: 14px; color: #9ca3af;">Your Activation Referral Code:</p>
            <h2 style="margin: 8px 0 0 0; color: #10b981; letter-spacing: 2px;">${inviteCode}</h2>
          </div>
          <a href="${CONFIG.appBaseUrl}/join?ref=${inviteCode}" style="display: inline-block; background: #6366f1; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold;">
            Activate Wallet & Claim Tokens
          </a>
          <hr style="margin-top: 32px; border: 0; border-top: 1px solid #1f2937;" />
          <p style="font-size: 12px; color: #6b7280; text-align: center;">Verified On-Chain by Segmento Protocol</p>
        </div>
      `,
    };

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.resendKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[Resend Error] Failed to send email: ${res.status} - ${errText}`);
        return false;
      }

      console.log(`[Resend Success] Email delivered to ${recipientEmail}`);
      return true;
    } catch (err) {
      console.error("[Resend Error] Network dispatch exception:", err);
      return false;
    }
  }

  async broadcastDiscordEvent(title: string, fields: { name: string; value: string; inline?: boolean }[]): Promise<void> {
    if (!this.discordUrl) return;

    const payload = {
      username: "Segmento Referral Engine",
      avatar_url: "https://segmento.app/logo.png",
      embeds: [
        {
          title: `🚀 ${title}`,
          color: 0x6366f1,
          fields,
          footer: { text: "Segmento Solana Mainnet Growth Daemon" },
          timestamp: new Date().toISOString(),
        },
      ],
    };

    try {
      const res = await fetch(this.discordUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        console.warn(`[Discord Warning] Webhook call returned status ${res.status}`);
      }
    } catch (err) {
      console.error("[Discord Warning] Webhook failed:", err);
    }
  }
}

// ==========================================
// SOLANA CORE EVENT LISTENER DAEMON
// ==========================================
export class SegmentoGrowthDaemon {
  private connection: Connection;
  private notifier: EnterpriseNotifier;
  private processedSignatures: Set<string>;

  constructor() {
    this.connection = new Connection(CONFIG.solanaRpcUrl, {
      wsEndpoint: CONFIG.solanaWsUrl,
      commitment: "confirmed",
    });
    this.notifier = new EnterpriseNotifier(CONFIG.resendApiKey, CONFIG.discordWebhookUrl);
    this.processedSignatures = new Set<string>();
  }

  public async start(): Promise<void> {
    console.log("=================================================");
    console.log("Segmento Growth & Referral Daemon Active");
    console.log(`Tracking Program: ${CONFIG.programId}`);
    console.log(`RPC Node: ${CONFIG.solanaRpcUrl}`);
    console.log("=================================================");

    const programPubkey = new PublicKey(CONFIG.programId);

    this.connection.onLogs(
      programPubkey,
      async (logsContext) => {
        const { signature, logs, err } = logsContext;
        if (err) return;
        if (this.processedSignatures.has(signature)) return;

        this.processedSignatures.add(signature);
        if (this.processedSignatures.size > 20000) {
          const firstItem = this.processedSignatures.values().next().value;
          if (firstItem) this.processedSignatures.delete(firstItem);
        }

        await this.handleLogSlice(logs, signature);
      },
      "confirmed"
    );
  }

  private async handleLogSlice(logs: string[], signature: string): Promise<void> {
    for (const log of logs) {
      if (log.includes("ReferralBound")) {
        console.log(`[Event Detected] ReferralBound in tx: ${signature}`);
        await this.notifier.broadcastDiscordEvent("New Friend Joined Segmento!", [
          { name: "Transaction Signature", value: `\`${signature}\``, inline: false },
          { name: "Network Status", value: "Verified on Solana Devnet/Mainnet", inline: true },
        ]);
      }

      if (log.includes("RewardDistributed")) {
        console.log(`[Event Detected] RewardDistributed in tx: ${signature}`);
        await this.notifier.broadcastDiscordEvent("Referral Bounty Unlocked & Paid!", [
          { name: "Attribution", value: "Referee Qualified", inline: true },
          { name: "Transaction", value: `\`${signature}\``, inline: false },
        ]);
      }
    }
  }
}

// Direct Execution Entrypoint
if (require.main === module) {
  const daemon = new SegmentoGrowthDaemon();
  daemon.start().catch((err) => {
    console.error("Daemon fatal fault:", err);
    process.exit(1);
  });
}