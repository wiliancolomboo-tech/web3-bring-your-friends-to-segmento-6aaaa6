import axios from "axios";
import { Resend } from "resend";
import { CONFIG } from "../config";
import winston from "winston";

const logger = winston.createLogger({
  level: "info",
  transports: [new winston.transports.Console()],
});

const resend = new Resend(CONFIG.RESEND_API_KEY);

export class EnterpriseNotificationHub {
  public static async sendReferralAlert(referee: string, referrer: string, txSignature: string): Promise<void> {
    const textMessage = `🚀 *Segmento Growth Alert*:\nNew wallet onboarded!\n• Referee: \`${referee}\`\n• Referrer: \`${referrer}\`\n• Tx: <https://solscan.io/tx/${txSignature}?cluster=devnet>`;

    // 1. Post to Slack if configured
    if (CONFIG.SLACK_WEBHOOK_URL) {
      try {
        await axios.post(CONFIG.SLACK_WEBHOOK_URL, { text: textMessage });
        logger.info(`Slack alert dispatched for referee: ${referee}`);
      } catch (err: any) {
        logger.error(`Failed to dispatch Slack alert: ${err.message}`);
      }
    }

    // 2. Post to Discord if configured
    if (CONFIG.DISCORD_WEBHOOK_URL) {
      try {
        await axios.post(CONFIG.DISCORD_WEBHOOK_URL, {
          embeds: [
            {
              title: "Segmento Referral Bound",
              color: 0x14f195,
              fields: [
                { name: "Referee", value: referee, inline: false },
                { name: "Referrer", value: referrer, inline: false },
                { name: "Solscan", value: `https://solscan.io/tx/${txSignature}`, inline: false },
              ],
              timestamp: new Date().toISOString(),
            },
          ],
        });
        logger.info(`Discord notification dispatched successfully`);
      } catch (err: any) {
        logger.error(`Failed to dispatch Discord alert: ${err.message}`);
      }
    }
  }

  public static async sendRewardAccrualEmail(
    recipientEmail: string,
    referrerPubkey: string,
    amountSol: number,
    cohort: string
  ): Promise<void> {
    if (!CONFIG.RESEND_API_KEY || CONFIG.RESEND_API_KEY.includes("dummy")) {
      logger.warn("Resend API key missing or set to dummy. Skipping email dispatch.");
      return;
    }

    try {
      await resend.emails.send({
        from: "Segmento Rewards <growth@segmento.network>",
        to: recipientEmail,
        subject: "🎉 You earned a new referral reward on Segmento!",
        html: `
          <div style="font-family: Arial, sans-serif; background: #0b0e14; color: #ffffff; padding: 24px; border-radius: 8px;">
            <h1 style="color: #14f195;">Congratulations!</h1>
            <p>Your referral link was utilized by a user in the <strong>${cohort}</strong> cohort.</p>
            <p style="font-size: 18px;">Earned: <strong>${amountSol.toFixed(4)} SOL</strong></p>
            <p>Wallet Address: <code>${referrerPubkey}</code></p>
            <hr style="border: 1px solid #222;" />
            <p style="font-size: 12px; color: #888;">This is an automated verified transaction notification from Segmento Nexus Engine.</p>
          </div>
        `,
      });
      logger.info(`Email successfully dispatched to ${recipientEmail}`);
    } catch (err: any) {
      logger.error(`Failed to send email via Resend: ${err.message}`);
    }
  }
}