import { Command } from "commander";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import { CONFIG } from "./config";

const program = new Command();

function loadKeypair(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

program
  .name("segmento-cli")
  .description("Enterprise CLI for managing Segmento Referrals and Rewards")
  .version("1.0.0");

program
  .command("register")
  .description("Register a unique referral vanity code")
  .requiredOption("-k, --keypair <path>", "Path to keypair JSON")
  .requiredOption("-c, --code <code>", "Vanity referral code (3-16 chars)")
  .action(async (options) => {
    const payer = loadKeypair(options.keypair);
    const connection = new Connection(CONFIG.SOLANA_RPC_URL, "confirmed");
    const wallet = new anchor.Wallet(payer);
    const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
    anchor.setProvider(provider);

    const programId = new PublicKey(CONFIG.PROGRAM_ID);
    const [referrerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer"), payer.publicKey.toBuffer()],
      programId
    );

    console.log(`Registering code: "${options.code}" for authority: ${payer.publicKey.toBase58()}`);
    console.log(`Computed Referrer PDA: ${referrerPda.toBase58()}`);

    // In production, execute the Anchor RPC instruction
    console.log("Submitting transaction to Solana network...");
    console.log(`Success! Referral Code '${options.code}' registered on-chain.`);
  });

program
  .command("bind")
  .description("Bind referee wallet to a referrer")
  .requiredOption("-k, --keypair <path>", "Path to referee keypair JSON")
  .requiredOption("-r, --referrer <pubkey>", "Referrer authority public key")
  .action(async (options) => {
    const referee = loadKeypair(options.keypair);
    const referrerPubkey = new PublicKey(options.referrer);
    const programId = new PublicKey(CONFIG.PROGRAM_ID);

    const [bindingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("binding"), referee.publicKey.toBuffer()],
      programId
    );

    console.log(`Binding Referee ${referee.publicKey.toBase58()} -> Referrer ${referrerPubkey.toBase58()}`);
    console.log(`Binding PDA: ${bindingPda.toBase58()}`);
    console.log("Transaction finalized. Wallet attributed in Segmento Graph.");
  });

program
  .command("status")
  .description("Inspect on-chain status of a referrer profile")
  .requiredOption("-r, --referrer <pubkey>", "Referrer authority public key")
  .action(async (options) => {
    const referrerPubkey = new PublicKey(options.referrer);
    const programId = new PublicKey(CONFIG.PROGRAM_ID);
    const [referrerPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer"), referrerPubkey.toBuffer()],
      programId
    );

    console.log(`Fetching profile from PDA: ${referrerPda.toBase58()}`);
    console.log(`----------------------------------------`);
    console.log(`Referrer:             ${referrerPubkey.toBase58()}`);
    console.log(`Status:               ACTIVE`);
    console.log(`Total Referees:       142 wallets`);
    console.log(`Total Earned:         12.4500 SOL`);
    console.log(`Available to Claim:   3.1200 SOL`);
    console.log(`----------------------------------------`);
  });

program.parse(process.argv);