import axios from "axios";
import { Resend } from "resend";

export interface ReferralNotificationPayload {
  campaignId: string;
  referrer: string;
  referredUser: string;
  payoutRaw: number;
  tier: string;
  referralCount: number;
  txSignature: string;
  referrerEmail?: string;
}

export class EnterpriseNotifier {
  private resendClient?: Resend;
  private slackWebhookUrl?: string;

  constructor() {
    if (process.env.RESEND_API_KEY) {
      this.resendClient = new Resend(process.env.RESEND_API_KEY);
    }
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  }

  public async notifySlack(payload: ReferralNotificationPayload): Promise<void> {
    if (!this.slackWebhookUrl) return;

    const slackBody = {
      text: `🚀 *New Segmento Referral Converted!*`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🎉 Segmento Growth: Friend Onboarded!",
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Campaign:* \`${payload.campaignId}\`` },
            { type: "mrkdwn", text: `*Payout:* \`${payload.payoutRaw} tokens\`` },
            { type: "mrkdwn", text: `*Referrer:* \`${payload.referrer.slice(0, 6)}...${payload.referrer.slice(-4)}\`` },
            { type: "mrkdwn", text: `*New Friend:* \`${payload.referredUser.slice(0, 6)}...${payload.referredUser.slice(-4)}\`` },
            { type: "mrkdwn", text: `*New Tier Level:* *${payload.tier}*` },
            { type: "mrkdwn", text: `*Total Referrals:* *${payload.referralCount}*` },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `🔗 <https://solscan.io/tx/${payload.txSignature}?cluster=devnet|View on Solscan>`,
            },
          ],
        },
      ],
    };

    try {
      await axios.post(this.slackWebhookUrl, slackBody, { timeout: 5000 });
      console.log(`[Notifier] Slack alert dispatched for tx: ${payload.txSignature}`);
    } catch (err: any) {
      console.error("[Notifier] Failed to send Slack alert:", err?.message || err);
    }
  }

  public async notifyResendEmail(payload: ReferralNotificationPayload): Promise<void> {
    if (!this.resendClient || !payload.referrerEmail) return;

    try {
      await this.resendClient.emails.send({
        from: "Segmento Growth <referrals@segmento.io>",
        to: payload.referrerEmail,
        subject: `Your friend joined Segmento! Reward disbursed: ${payload.payoutRaw} tokens`,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #111;">
            <h2>You earned a referral bonus on Segmento!</h2>
            <p>Your friend <code>${payload.referredUser}</code> just completed verification and joined.</p>
            <ul>
              <li><strong>Reward:</strong> ${payload.payoutRaw} tokens transferred to your wallet</li>
              <li><strong>Current Tier:</strong> ${payload.tier}</li>
              <li><strong>Total Lifetime Friends Brought:</strong> ${payload.referralCount}</li>
            </ul>
            <p><a href="https://solscan.io/tx/${payload.txSignature}?cluster=devnet" style="color: #6366f1;">Inspect Transaction on Solscan</a></p>
            <hr />
            <small>Segmento Audience & Referral Protocol Engine</small>
          </div>
        `,
      });
      console.log(`[Notifier] Resend email dispatched to: ${payload.referrerEmail}`);
    } catch (err: any) {
      console.error("[Notifier] Resend email failed:", err?.message || err);
    }
  }
}