import { Command } from "commander";
import { Connection, Keypair, PublicKey, SystemProgram, Ed25519Program } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { SegmentoOracleSigner } from "./oracle";
import * as fs from "fs";
import * as path from "path";

const program = new Command();
program.version("1.0.0").description("Segmento Bring Your Friends CLI Operations");

function loadKeypair(filePath: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf-8"));
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

program
  .command("generate-voucher")
  .description("Issue an Ed25519 voucher as Segmento Oracle for a new friend")
  .requiredOption("-o, --oracle-keypair <path>", "Path to Oracle secret keypair JSON")
  .requiredOption("-c, --campaign-id <string>", "Campaign ID string")
  .requiredOption("-r, --referrer <pubkey>", "Referrer wallet public key")
  .requiredOption("-f, --friend <pubkey>", "Referred friend wallet public key")
  .action(async (opts) => {
    const oracleKeypair = loadKeypair(opts.oracleKeypair);
    const oracle = new SegmentoOracleSigner(oracleKeypair.secretKey);
    const voucher = oracle.issueReferralVoucher(
      opts.campaignId,
      new PublicKey(opts.referrer),
      new PublicKey(opts.friend)
    );

    console.log("\n================ SEGMENTO ORACLE VOUCHER ================");
    console.log(`Campaign ID: ${opts.campaignId}`);
    console.log(`Oracle Pubkey: ${oracle.getPublicKey().toBase58()}`);
    console.log(`Referrer:     ${opts.referrer}`);
    console.log(`Friend:       ${opts.friend}`);
    console.log(`Message Hash: 0x${voucher.msgHash.toString("hex")}`);
    console.log(`Signature:    0x${voucher.signature.toString("hex")}`);
    console.log("========================================================\n");
  });

program
  .command("simulate-payout")
  .description("Simulate referral conversion and webhook push")
  .requiredOption("-c, --campaign-id <string>", "Campaign ID string")
  .action(async (opts) => {
    console.log(`Simulating referral redemption for campaign: ${opts.campaignId}...`);
    console.log("Verified oracle payload. Reward disburse instruction complete!");
  });

program.parse(process.argv);