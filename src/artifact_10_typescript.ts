import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SegmentoReferrals } from "../target/types/segmento_referrals";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Ed25519Program,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import * as nacl from "tweetnacl";
import { createHash } from "crypto";

describe("Segmento 'Bring Your Friends' Referral Protocol Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SegmentoReferrals as Program<SegmentoReferrals>;
  const campaignId = "segmento_growth_q2";

  const authority = Keypair.generate();
  const oracleKeypair = Keypair.generate();
  const referrer = Keypair.generate();
  const referredUser1 = Keypair.generate();
  const referredUser2 = Keypair.generate();

  let rewardMint: PublicKey;
  let authorityTokenAccount: PublicKey;
  let referrerTokenAccount: PublicKey;
  let campaignPda: PublicKey;
  let vaultPda: PublicKey;
  let referrerProfilePda: PublicKey;

  const baseReward = new anchor.BN(10_000_000); // 10 tokens (at 6 decimals)
  const tier1Threshold = 2;
  const tier1MultiplierBps = 15000; // 1.5x payout
  const tier2Threshold = 5;
  const tier2MultiplierBps = 20000; // 2.0x payout

  before(async () => {
    // Airdrop SOL to test actors
    const airdropPromises = [authority, oracleKeypair, referrer, referredUser1, referredUser2].map(
      async (actor) => {
        const sig = await provider.connection.requestAirdrop(actor.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
        await provider.connection.confirmTransaction(sig, "confirmed");
      }
    );
    await Promise.all(airdropPromises);

    // Initialize Mint
    rewardMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Derive PDAs
    [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), Buffer.from(campaignId)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(campaignId)],
      program.programId
    );

    [referrerProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer"), Buffer.from(campaignId), referrer.publicKey.toBuffer()],
      program.programId
    );

    // Setup Token Accounts
    authorityTokenAccount = await createAccount(
      provider.connection,
      authority,
      rewardMint,
      authority.publicKey
    );

    referrerTokenAccount = await createAccount(
      provider.connection,
      referrer,
      rewardMint,
      referrer.publicKey
    );

    // Mint supply to Authority
    await mintTo(
      provider.connection,
      authority,
      rewardMint,
      authorityTokenAccount,
      authority,
      1_000_000_000 // 1,000 tokens
    );
  });

  it("1. Successfully initializes a Segmento Campaign with dynamic tiers", async () => {
    await program.methods
      .initializeCampaign(
        campaignId,
        baseReward,
        tier1Threshold,
        tier1MultiplierBps,
        tier2Threshold,
        tier2MultiplierBps,
        oracleKeypair.publicKey
      )
      .accounts({
        authority: authority.publicKey,
        campaign: campaignPda,
        rewardMint: rewardMint,
        rewardVault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const campaign = await program.account.campaign.fetch(campaignPda);
    expect(campaign.campaignId).to.equal(campaignId);
    expect(campaign.oraclePubkey.toBase58()).to.equal(oracleKeypair.publicKey.toBase58());
    expect(campaign.baseReward.toNumber()).to.equal(baseReward.toNumber());
    expect(campaign.isActive).to.be.true;
  });

  it("2. Funds the campaign escrow vault with token liquidity", async () => {
    const depositAmount = new anchor.BN(500_000_000); // 500 tokens

    await program.methods
      .fundCampaignVault(depositAmount)
      .accounts({
        funder: authority.publicKey,
        campaign: campaignPda,
        rewardVault: vaultPda,
        funderTokenAccount: authorityTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(depositAmount.toNumber());
  });

  it("3. Registers a referrer profile for Alice", async () => {
    await program.methods
      .registerReferrer()
      .accounts({
        referrer: referrer.publicKey,
        campaign: campaignPda,
        referrerProfile: referrerProfilePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([referrer])
      .rpc();

    const profile = await program.account.referrerProfile.fetch(referrerProfilePda);
    expect(profile.referrer.toBase58()).to.equal(referrer.publicKey.toBase58());
    expect(profile.referralCount).to.equal(0);
  });

  it("4. Rejects Self-Referral attempts (Sybil check)", async () => {
    const payload = Buffer.concat([
      Buffer.from(campaignId),
      referrer.publicKey.toBuffer(),
      referrer.publicKey.toBuffer(),
    ]);
    const hash = createHash("sha256").update(payload).digest();
    const signature = nacl.sign.detached(hash, oracleKeypair.secretKey);

    const [selfReferralLinkPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referral_link"), Buffer.from(campaignId), referrer.publicKey.toBuffer()],
      program.programId
    );

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: oracleKeypair.publicKey.toBytes(),
      message: hash,
      signature: signature,
    });

    const claimIx = await program.methods
      .claimReferral(Array.from(signature), Array.from(hash))
      .accounts({
        referredUser: referrer.publicKey,
        referrer: referrer.publicKey,
        campaign: campaignPda,
        referrerProfile: referrerProfilePda,
        referralLink: selfReferralLinkPda,
        rewardVault: vaultPda,
        referrerTokenAccount: referrerTokenAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);

    try {
      await provider.sendAndConfirm(tx, [referrer]);
      expect.fail("Should have thrown SelfReferralProhibited error");
    } catch (err: any) {
      expect(err.toString()).to.include("SelfReferralProhibited");
    }
  });

  it("5. Successfully processes Friend #1 (Base Tier Reward Disbursed)", async () => {
    const payload = Buffer.concat([
      Buffer.from(campaignId),
      referrer.publicKey.toBuffer(),
      referredUser1.publicKey.toBuffer(),
    ]);
    const hash = createHash("sha256").update(payload).digest();
    const signature = nacl.sign.detached(hash, oracleKeypair.secretKey);

    const [referralLink1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referral_link"), Buffer.from(campaignId), referredUser1.publicKey.toBuffer()],
      program.programId
    );

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: oracleKeypair.publicKey.toBytes(),
      message: hash,
      signature: signature,
    });

    const claimIx = await program.methods
      .claimReferral(Array.from(signature), Array.from(hash))
      .accounts({
        referredUser: referredUser1.publicKey,
        referrer: referrer.publicKey,
        campaign: campaignPda,
        referrerProfile: referrerProfilePda,
        referralLink: referralLink1Pda,
        rewardVault: vaultPda,
        referrerTokenAccount: referrerTokenAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);
    await provider.sendAndConfirm(tx, [referredUser1]);

    const profile = await program.account.referrerProfile.fetch(referrerProfilePda);
    expect(profile.referralCount).to.equal(1);
    expect(profile.totalEarned.toNumber()).to.equal(baseReward.toNumber());

    const referrerBal = await getAccount(provider.connection, referrerTokenAccount);
    expect(Number(referrerBal.amount)).to.equal(baseReward.toNumber());
  });

  it("6. Rejects duplicate redemption from the same friend (Replay Protection)", async () => {
    const payload = Buffer.concat([
      Buffer.from(campaignId),
      referrer.publicKey.toBuffer(),
      referredUser1.publicKey.toBuffer(),
    ]);
    const hash = createHash("sha256").update(payload).digest();
    const signature = nacl.sign.detached(hash, oracleKeypair.secretKey);

    const [referralLink1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referral_link"), Buffer.from(campaignId), referredUser1.publicKey.toBuffer()],
      program.programId
    );

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: oracleKeypair.publicKey.toBytes(),
      message: hash,
      signature: signature,
    });

    const claimIx = await program.methods
      .claimReferral(Array.from(signature), Array.from(hash))
      .accounts({
        referredUser: referredUser1.publicKey,
        referrer: referrer.publicKey,
        campaign: campaignPda,
        referrerProfile: referrerProfilePda,
        referralLink: referralLink1Pda,
        rewardVault: vaultPda,
        referrerTokenAccount: referrerTokenAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);

    try {
      await provider.sendAndConfirm(tx, [referredUser1]);
      expect.fail("Should have failed on duplicate PDA creation");
    } catch (err: any) {
      expect(err.logs.some((l: string) => l.includes("already in use"))).to.be.true;
    }
  });

  it("7. Step-up to Tier 1 Multiplier on Friend #2 conversion", async () => {
    const payload = Buffer.concat([
      Buffer.from(campaignId),
      referrer.publicKey.toBuffer(),
      referredUser2.publicKey.toBuffer(),
    ]);
    const hash = createHash("sha256").update(payload).digest();
    const signature = nacl.sign.detached(hash, oracleKeypair.secretKey);

    const [referralLink2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referral_link"), Buffer.from(campaignId), referredUser2.publicKey.toBuffer()],
      program.programId
    );

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: oracleKeypair.publicKey.toBytes(),
      message: hash,
      signature: signature,
    });

    const claimIx = await program.methods
      .claimReferral(Array.from(signature), Array.from(hash))
      .accounts({
        referredUser: referredUser2.publicKey,
        referrer: referrer.publicKey,
        campaign: campaignPda,
        referrerProfile: referrerProfilePda,
        referralLink: referralLink2Pda,
        rewardVault: vaultPda,
        referrerTokenAccount: referrerTokenAccount,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ed25519Ix).add(claimIx);
    await provider.sendAndConfirm(tx, [referredUser2]);

    const profile = await program.account.referrerProfile.fetch(referrerProfilePda);
    expect(profile.referralCount).to.equal(2);
    // Tier 1 calculation: 10 * 1.5 = 15 tokens. Total earned: 10 + 15 = 25 tokens.
    expect(profile.totalEarned.toNumber()).to.equal(25_000_000);

    const referrerBal = await getAccount(provider.connection, referrerTokenAccount);
    expect(Number(referrerBal.amount)).to.equal(25_000_000);
  });
});