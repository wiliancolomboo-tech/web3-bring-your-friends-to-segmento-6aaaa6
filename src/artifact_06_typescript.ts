import { Command } from "commander";
import { Connection, Keypair, PublicKey, clusterApiUrl, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const program = new Command();
program
  .name("segmento-cli")
  .description("Bring Your Friends to Segmento - Production Protocol CLI")
  .version("1.0.0");

function loadKeypair(keypairPath: string): Keypair {
  const resolved = path.resolve(keypairPath);
  const secret = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

program
  .command("generate-link")
  .description("Generate deterministic on-chain referral URL and verify PDA")
  .requiredOption("-k, --keypair <path>", "Path to referrer keypair file")
  .requiredOption("-c, --campaign <name>", "Campaign code or tag", "spring-growth")
  .action(async (options) => {
    const keypair = loadKeypair(options.keypair);
    const PROGRAM_ID = new PublicKey("SegmXyZ9oQGzK4rN1aWqT7uE3jVpB5mF8sC2dD6hA1B");
    const [referralPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referral_state"), keypair.publicKey.toBuffer()],
      PROGRAM_ID
    );

    console.log("==================================================");
    console.log("🔗 SEGMENTO REFERRAL LINK GENERATOR");
    console.log("==================================================");
    console.log(`Referrer Wallet : ${keypair.publicKey.toBase58()}`);
    console.log(`Campaign Tag    : ${options.campaign}`);
    console.log(`On-Chain PDA    : ${referralPda.toBase58()}`);
    console.log(`Unique Invite URL: https://app.segmento.io/join?ref=${keypair.publicKey.toBase58()}&camp=${options.campaign}`);
    console.log("==================================================");
  });

program
  .command("vault-balance")
  .description("Check Segmento Escrow Reward Vault status")
  .option("-r, --rpc <url>", "RPC URL", clusterApiUrl("devnet"))
  .action(async (options) => {
    const connection = new Connection(options.rpc, "confirmed");
    const PROGRAM_ID = new PublicKey("SegmXyZ9oQGzK4rN1aWqT7uE3jVpB5mF8sC2dD6hA1B");
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("segmento_config")], PROGRAM_ID);
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault"), configPda.toBuffer()],
      PROGRAM_ID
    );

    const balance = await connection.getBalance(vaultPda);
    console.log("==================================================");
    console.log(`Vault PDA : ${vaultPda.toBase58()}`);
    console.log(`Balance   : ${balance / LAMPORTS_PER_SOL} SOL (${balance} lamports)`);
    console.log("==================================================");
  });

program.parse(process.argv);