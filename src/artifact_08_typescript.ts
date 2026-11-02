import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SegmentoReferral } from "../target/types/segmento_referral";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("segmento_referral e2e test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SegmentoReferral as Program<SegmentoReferral>;

  const admin = (provider.wallet as any).payer as Keypair;
  const referrer = Keypair.generate();
  const invitee = Keypair.generate();
  const attacker = Keypair.generate();

  let rewardMint: PublicKey;
  let campaignPda: PublicKey;
  let campaignBump: number;
  let vaultPda: PublicKey;
  let referrerProfilePda: PublicKey;
  let attributionRecordPda: PublicKey;

  let referrerTokenAccount: PublicKey;
  let inviteeTokenAccount: PublicKey;

  const campaignId = "SEGMENTO_DEV_2025";
  const baseReward = new anchor.BN(50_000_000); // 50 tokens
  const welcomeReward = new anchor.BN(20_000_000); // 20 tokens
  const tierStep = 2; // Step every 2 referrals
  const tierBonusBps = 1000; // 10% bonus per tier step

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [referrer, invitee, attacker]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Create reward token mint
    rewardMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Derive PDAs
    [campaignPda, campaignBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), Buffer.from(campaignId)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reward_vault"), campaignPda.toBuffer()],
      program.programId
    );

    [referrerProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referral"), campaignPda.toBuffer(), referrer.publicKey.toBuffer()],
      program.programId
    );

    [attributionRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("attribution"), campaignPda.toBuffer(), invitee.publicKey.toBuffer()],
      program.programId
    );

    // Create token accounts
    referrerTokenAccount = await createAccount(
      provider.connection,
      admin,
      rewardMint,
      referrer.publicKey
    );

    inviteeTokenAccount = await createAccount(
      provider.connection,
      admin,
      rewardMint,
      invitee.publicKey
    );
  });

  it("1. Successfully initializes a Segmento Campaign with Reward Vault", async () => {
    await program.methods
      .initializeCampaign(
        campaignId,
        baseReward,
        welcomeReward,
        tierStep,
        tierBonusBps
      )
      .accounts({
        campaign: campaignPda,
        rewardMint: rewardMint,
        rewardVault: vaultPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const campaignState = await program.account.campaign.fetch(campaignPda);
    expect(campaignState.campaignId).to.equal(campaignId);
    expect(campaignState.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(campaignState.referrerBaseReward.eq(baseReward)).to.be.true;

    // Fund Reward Vault with 1,000 tokens
    await mintTo(
      provider.connection,
      admin,
      rewardMint,
      vaultPda,
      admin,
      1_000_000_000
    );

    const vaultAccount = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAccount.amount)).to.equal(1_000_000_000);
  });

  it("2. Allows referrer to register a Referral Profile PDA", async () => {
    await program.methods
      .createReferralProfile("alice_segmento")
      .accounts({
        referralProfile: referrerProfilePda,
        campaign: campaignPda,
        referrer: referrer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([referrer])
      .rpc();

    const profile = await program.account.referralProfile.fetch(referrerProfilePda);
    expect(profile.referrer.toBase58()).to.equal(referrer.publicKey.toBase58());
    expect(profile.customAlias).to.equal("alice_segmento");
    expect(profile.successfulReferrals).to.equal(0);
  });

  it("3. Successfully attributes an invitee and distributes rewards atomically", async () => {
    await program.methods
      .claimReferral()
      .accounts({
        campaign: campaignPda,
        referralProfile: referrerProfilePda,
        attribution: attributionRecordPda,
        referrer: referrer.publicKey,
        invitee: invitee.publicKey,
        rewardVault: vaultPda,
        referrerTokenAccount: referrerTokenAccount,
        inviteeTokenAccount: inviteeTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([invitee])
      .rpc();

    // Verify referrer received base reward
    const refTokenBal = await getAccount(provider.connection, referrerTokenAccount);
    expect(Number(refTokenBal.amount)).to.equal(50_000_000);

    // Verify invitee received welcome reward
    const invTokenBal = await getAccount(provider.connection, inviteeTokenAccount);
    expect(Number(invTokenBal.amount)).to.equal(20_000_000);

    // Verify attribution proof record
    const attribution = await program.account.attributionRecord.fetch(attributionRecordPda);
    expect(attribution.invitee.toBase58()).to.equal(invitee.publicKey.toBase58());
    expect(attribution.referrer.toBase58()).to.equal(referrer.publicKey.toBase58());
  });

  it("4. Rejects Self-Referral attempts (Sybil prevention)", async () => {
    const [selfProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referral"), campaignPda.toBuffer(), attacker.publicKey.toBuffer()],
      program.programId
    );

    // Create profile for attacker
    await program.methods
      .createReferralProfile("attacker")
      .accounts({
        referralProfile: selfProfilePda,
        campaign: campaignPda,
        referrer: attacker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([attacker])
      .rpc();

    const [selfAttributionPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("attribution"), campaignPda.toBuffer(), attacker.publicKey.toBuffer()],
      program.programId
    );

    const attackerTokenAccount = await createAccount(
      provider.connection,
      admin,
      rewardMint,
      attacker.publicKey
    );

    try {
      await program.methods
        .claimReferral()
        .accounts({
          campaign: campaignPda,
          referralProfile: selfProfilePda,
          attribution: selfAttributionPda,
          referrer: attacker.publicKey,
          invitee: attacker.publicKey, // Same pubkey
          rewardVault: vaultPda,
          referrerTokenAccount: attackerTokenAccount,
          inviteeTokenAccount: attackerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([attacker])
        .rpc();

      expect.fail("Should have failed on self-referral");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SelfReferralForbidden");
    }
  });

  it("5. Rejects Duplicate Attribution attempts for same invitee", async () => {
    try {
      await program.methods
        .claimReferral()
        .accounts({
          campaign: campaignPda,
          referralProfile: referrerProfilePda,
          attribution: attributionRecordPda, // already initialized
          referrer: referrer.publicKey,
          invitee: invitee.publicKey,
          rewardVault: vaultPda,
          referrerTokenAccount: referrerTokenAccount,
          inviteeTokenAccount: inviteeTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([invitee])
        .rpc();

      expect.fail("Should have failed on duplicate attribution PDA initialization");
    } catch (err: any) {
      // Anchor/System program rejects re-init of existing PDA
      expect(err.toString()).to.include("already in use");
    }
  });
});