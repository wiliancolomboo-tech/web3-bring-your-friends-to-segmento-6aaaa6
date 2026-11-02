import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SegmentoReferrals } from "../target/types/segmento_referrals";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

describe("segmento_referrals_e2e_matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SegmentoReferrals as Program<SegmentoReferrals>;

  const campaignId = "growth-q3-2024-" + Math.floor(Math.random() * 10000);
  const authority = Keypair.generate();
  const oracleSigner = Keypair.generate();
  const referrer = Keypair.generate();
  const referee = Keypair.generate();
  const attacker = Keypair.generate();

  let campaignPda: PublicKey;
  let vaultPda: PublicKey;
  let referralRecordPda: PublicKey;

  const referrerRewardLamports = new anchor.BN(0.05 * LAMPORTS_PER_SOL);
  const refereeRewardLamports = new anchor.BN(0.02 * LAMPORTS_PER_SOL);
  const totalFundingLamports = new anchor.BN(1.0 * LAMPORTS_PER_SOL);

  before(async () => {
    // Airdrop funds to actors
    const airdropPromises = [
      authority.publicKey,
      oracleSigner.publicKey,
      referrer.publicKey,
      referee.publicKey,
      attacker.publicKey,
    ].map(async (pubkey) => {
      const sig = await provider.connection.requestAirdrop(pubkey, 5 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    });
    await Promise.all(airdropPromises);

    // Derive PDAs
    [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), Buffer.from(campaignId)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from(campaignId)],
      program.programId
    );

    [referralRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referral"), Buffer.from(campaignId), referee.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Initializes a new Segmento referral campaign with deterministic escrow", async () => {
    await program.methods
      .initializeCampaign(
        campaignId,
        referrerRewardLamports,
        refereeRewardLamports,
        100 // max referrals
      )
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        oracleSigner: oracleSigner.publicKey,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority, oracleSigner])
      .rpc();

    const campaignAccount = await program.account.campaign.fetch(campaignPda);
    expect(campaignAccount.campaignId).to.equal(campaignId);
    expect(campaignAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(campaignAccount.referrerRewardLamports.toNumber()).to.equal(referrerRewardLamports.toNumber());
    expect(campaignAccount.refereeRewardLamports.toNumber()).to.equal(refereeRewardLamports.toNumber());
    expect(campaignAccount.isActive).to.be.true;
    expect(campaignAccount.referralCount).to.equal(0);
  });

  it("2. Funds the escrow vault with native SOL", async () => {
    await program.methods
      .fundCampaign(totalFundingLamports)
      .accounts({
        campaign: campaignPda,
        vault: vaultPda,
        funder: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.be.gte(totalFundingLamports.toNumber());

    const campaignAccount = await program.account.campaign.fetch(campaignPda);
    expect(campaignAccount.totalAllocated.toNumber()).to.equal(totalFundingLamports.toNumber());
  });

  it("3. Prevents self-referral (Anti-Sybil enforcement)", async () => {
    const [selfReferralPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referral"), Buffer.from(campaignId), referrer.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .acceptReferral(campaignId)
        .accounts({
          campaign: campaignPda,
          referralRecord: selfReferralPda,
          referrer: referrer.publicKey,
          referee: referrer.publicKey, // SAME ADDRESS
          systemProgram: SystemProgram.programId,
        })
        .signers([referrer])
        .rpc();
      expect.fail("Expected SelfReferralNotPermitted error was not thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SelfReferralNotPermitted");
    }
  });

  it("4. Binds legitimate referee to referrer via accept_referral", async () => {
    await program.methods
      .acceptReferral(campaignId)
      .accounts({
        campaign: campaignPda,
        referralRecord: referralRecordPda,
        referrer: referrer.publicKey,
        referee: referee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([referee])
      .rpc();

    const record = await program.account.referralRecord.fetch(referralRecordPda);
    expect(record.referrer.toBase58()).to.equal(referrer.publicKey.toBase58());
    expect(record.referee.toBase58()).to.equal(referee.publicKey.toBase58());
    expect(record.isCompleted).to.be.false;
    expect(record.segmentTier).to.equal(0);
  });

  it("5. Rejects unauthorized milestone attestation from non-oracle signer", async () => {
    const dummyProof = new Array(64).fill(1);
    try {
      await program.methods
        .completeMilestone(campaignId, 2 /* Tier 2 */, dummyProof)
        .accounts({
          campaign: campaignPda,
          referralRecord: referralRecordPda,
          vault: vaultPda,
          referrer: referrer.publicKey,
          referee: referee.publicKey,
          oracleSigner: attacker.publicKey, // Malicious oracle attempt
        })
        .signers([attacker])
        .rpc();
      expect.fail("Expected UnauthorizedOracle error was not thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedOracle");
    }
  });

  it("6. Completes milestone, assigns segment tier, and releases rewards atomically", async () => {
    const prevReferrerBal = await provider.connection.getBalance(referrer.publicKey);
    const prevRefereeBal = await provider.connection.getBalance(referee.publicKey);

    const dummyProof = new Array(64).fill(7);
    const assignedTier = 3; // Whale cohort

    await program.methods
      .completeMilestone(campaignId, assignedTier, dummyProof)
      .accounts({
        campaign: campaignPda,
        referralRecord: referralRecordPda,
        vault: vaultPda,
        referrer: referrer.publicKey,
        referee: referee.publicKey,
        oracleSigner: oracleSigner.publicKey,
      })
      .signers([oracleSigner])
      .rpc();

    const postReferrerBal = await provider.connection.getBalance(referrer.publicKey);
    const postRefereeBal = await provider.connection.getBalance(referee.publicKey);

    // Verify payouts were received
    expect(postReferrerBal - prevReferrerBal).to.equal(referrerRewardLamports.toNumber());
    expect(postRefereeBal - prevRefereeBal).to.equal(refereeRewardLamports.toNumber());

    // Verify PDA state update
    const record = await program.account.referralRecord.fetch(referralRecordPda);
    expect(record.isCompleted).to.be.true;
    expect(record.segmentTier).to.equal(assignedTier);
  });

  it("7. Prevents double-claim replay on already-settled milestone", async () => {
    const dummyProof = new Array(64).fill(7);
    try {
      await program.methods
        .completeMilestone(campaignId, 3, dummyProof)
        .accounts({
          campaign: campaignPda,
          referralRecord: referralRecordPda,
          vault: vaultPda,
          referrer: referrer.publicKey,
          referee: referee.publicKey,
          oracleSigner: oracleSigner.publicKey,
        })
        .signers([oracleSigner])
        .rpc();
      expect.fail("Expected ReferralAlreadyCompleted error was not thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ReferralAlreadyCompleted");
    }
  });
});