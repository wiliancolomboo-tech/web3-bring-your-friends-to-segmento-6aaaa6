import * as anchor from "@coral-xyz/anchor";
import { Program, Idl } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

export interface GatewayConfig {
  rpcUrl: string;
  programId: string;
  resendApiKey: string;
  discordWebhookUrl: string;
  adminKeypair: Keypair;
}

export class SegmentoGateway {
  private connection: Connection;
  private program: Program;
  private resendApiKey: string;
  private discordWebhookUrl: string;
  private adminKeypair: Keypair;

  constructor(config: GatewayConfig, idl: Idl) {
    this.connection = new Connection(config.rpcUrl, "confirmed");
    this.resendApiKey = config.resendApiKey;
    this.discordWebhookUrl = config.discordWebhookUrl;
    this.adminKeypair = config.adminKeypair;

    const wallet = new anchor.Wallet(this.adminKeypair);
    const provider = new anchor.AnchorProvider(this.connection, wallet, {
      preflightCommitment: "confirmed",
    });
    this.program = new Program(idl, provider);
  }

  /**
   * Derive Deterministic PDAs
   */
  public getReferrerPda(authority: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("referrer"), authority.toBuffer()],
      this.program.programId
    );
  }

  public getCampaignPda(authority: PublicKey, campaignId: anchor.BN): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("campaign"),
        authority.toBuffer(),
        campaignId.toArrayLike(Buffer, "le", 8),
      ],
      this.program.programId
    );
  }

  public getEscrowPda(campaignPda: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), campaignPda.toBuffer()],
      this.program.programId
    );
  }

  public getReferralLinkPda(
    campaignPda: PublicKey,
    referee: PublicKey
  ): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("referral-link"), campaignPda.toBuffer(), referee.toBuffer()],
      this.program.programId
    );
  }

  /**
   * Enterprise Resend Email Invitation
   */
  public async sendReferralEmailInvitation(
    recipientEmail: string,
    referrerPubkey: string,
    campaignName: string,
    inviteLink: string
  ): Promise<boolean> {
    try {
      const emailPayload = {
        from: "Segmento Growth <invite@segmento.io>",
        to: [recipientEmail],
        subject: `Your friend invited you to join Segmento (${campaignName})`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 32px; border: 1px solid #1f2937; border-radius: 12px; background-color: #0b0f19; color: #f3f4f6;">
            <h1 style="color: #6366f1; font-size: 24px; font-weight: 700;">Welcome to Segmento</h1>
            <p style="font-size: 16px; line-height: 24px; color: #d1d5db;">
              Your friend (<code>${referrerPubkey.slice(0, 4)}...${referrerPubkey.slice(-4)}</code>) has invited you to join the on-chain attribution revolution.
            </p>
            <div style="margin: 28px 0; text-align: center;">
              <a href="${inviteLink}" style="background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #ffffff; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">
                Activate & Claim Cashback
              </a>
            </div>
            <p style="font-size: 12px; color: #6b7280; text-align: center;">
              Protected by Solana Proof-of-Activation. No cookies, no tracking compromises.
            </p>
          </div>
        `,
      };

      const response = await axios.post("https://api.resend.com/emails", emailPayload, {
        headers: {
          Authorization: `Bearer ${this.resendApiKey}`,
          "Content-Type": "application/json",
        },
      });

      console.log(`[Resend] Email successfully dispatched. ID: ${response.data.id}`);
      return true;
    } catch (err: any) {
      console.error("[Resend] Error delivering invitation email:", err.response?.data || err.message);
      return false;
    }
  }

  /**
   * Enterprise Discord Webhook Notification
   */
  public async postDiscordTelemetry(title: string, description: string, fields: Array<{ name: string; value: string; inline?: boolean }>) {
    if (!this.discordWebhookUrl) return;

    try {
      await axios.post(this.discordWebhookUrl, {
        username: "Segmento Referral Engine",
        avatar_url: "https://segmento.io/logo.png",
        embeds: [
          {
            title,
            description,
            color: 0x6366f1,
            fields,
            timestamp: new Date().toISOString(),
            footer: { text: "Segmento Solana Network Sentinel" },
          },
        ],
      });
    } catch (err: any) {
      console.error("[Discord Webhook] Failed to deliver alert:", err.message);
    }
  }

  /**
   * Real-time Solana Event Listener Daemon
   */
  public async startEventListenerDaemon() {
    console.log("[Daemon] Subscribing to Segmento on-chain activation events...");

    this.program.addEventListener("ReferralActivatedEvent", async (event: any, slot: number) => {
      console.log(`\n[EVENT DETECTED] Referral Activated in Slot ${slot}`);
      const referrerLamports = Number(event.referrerReward);
      const refereeLamports = Number(event.refereeReward);

      console.log(`Referrer: ${event.referrer.toBase58()} (+${referrerLamports / LAMPORTS_PER_SOL} SOL)`);
      console.log(`Referee:  ${event.referee.toBase58()} (+${refereeLamports / LAMPORTS_PER_SOL} SOL)`);

      await this.postDiscordTelemetry(
        "🎉 New Referral Activated & Settled!",
        "A user successfully onboarded their friend and triggered an on-chain milestone payout.",
        [
          { name: "Campaign", value: `\`${event.campaign.toBase58()}\``, inline: false },
          { name: "Referrer Payout", value: `${referrerLamports / LAMPORTS_PER_SOL} SOL`, inline: true },
          { name: "Referee Cashback", value: `${refereeLamports / LAMPORTS_PER_SOL} SOL`, inline: true },
        ]
      );
    });
  }
}