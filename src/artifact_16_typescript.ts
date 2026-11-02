import dotenv from "dotenv";
dotenv.config();

export const CONFIG = {
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  SOLANA_WSS_URL: process.env.SOLANA_WSS_URL || "wss://api.devnet.solana.com",
  PROGRAM_ID: process.env.PROGRAM_ID || "SegmX11111111111111111111111111111111111111",
  ADMIN_PRIVATE_KEY: process.env.ADMIN_PRIVATE_KEY || "",
  RESEND_API_KEY: process.env.RESEND_API_KEY || "re_test_dummy_key",
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || "",
  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || "",
  PORT: parseInt(process.env.PORT || "8080", 10),
};