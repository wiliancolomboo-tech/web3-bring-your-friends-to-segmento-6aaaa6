import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SegmentoReferral } from "../target/types/segmento_referral";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";
import crypto from "crypto";

describe("segmento_referral test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SegmentoReferral as Program<SegmentoReferral>;

  const campaignId = new anchor.BN(42069);
  const baseReward = new anchor.BN(10_000_000); // 10 tokens (with 6 decimals)
  const referrerBps = 1000; // 10%
  const refereeBps = 500;   // 5%

  let mintKeypair: Keypair;
  let mintPubkey: PublicKey;
  let campaignPolicyPda: PublicKey;
  let rewardVaultPda: PublicKey;

  const referrerWallet = Keypair.generate();
  const refereeWallet = Keypair.generate();

  let referrerTokenAccount: PublicKey;
  let refereeTokenAccount: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    const signature1 = await provider.connection.requestAirdrop(referrerWallet.publicKey, 2e9);
    const signature2 = await provider.connection.requestAirdrop(refereeWallet.publicKey, 2e9);
    await provider.connection.confirmTransaction(signature1);
    await provider.connection.confirmTransaction(signature2);

    // Create reward mint
    mintKeypair = Keypair.generate();
    mintPubkey = await createMint(
      provider.connection,
      (provider.wallet as any).payer,
      provider.wallet.publicKey,
      null,
      6
    );

    // Derive Campaign PDAs
    [campaignPolicyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), campaignId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [rewardVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignPolicyPda.toBuffer()],
      program.programId
    );

    // Create ATAs
    referrerTokenAccount = await createAccount(
      provider.connection,
      (provider.wallet as any).payer,
      mintPubkey,
      referrerWallet.publicKey
    );

    refereeTokenAccount = await createAccount(
      provider.connection,
      (provider.wallet as any).payer,
      mintPubkey,
      refereeWallet.publicKey
    );
  });

  it("1. Initializes Campaign Policy and Token Escrow Vault", async () => {
    await program.methods
      .initializeCampaign(campaignId, referrerBps, refereeBps, baseReward)
      .accounts({
        authority: provider.wallet.publicKey,
        rewardMint: mintPubkey,
        campaignPolicy: campaignPolicyPda,
        rewardVault: rewardVaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    // Fund the vault with 10,000 SPL tokens
    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      mintPubkey,
      rewardVaultPda,
      provider.wallet.publicKey,
      10_000_000_000
    );

    const vaultAccount = await getAccount(provider.connection, rewardVaultPda);
    assert.equal(vaultAccount.amount.toString(), "10000000000");

    const policy = await program.account.campaignPolicy.fetch(campaignPolicyPda);
    assert.equal(policy.campaignId.toString(), campaignId.toString());
    assert.equal(policy.referrerBps, referrerBps);
    assert.equal(policy.refereeBps, refereeBps);
    assert.isTrue(policy.isActive);
  });

  it("2. Registers Referrer Profile with SHA256 Code Hash", async () => {
    const rawCode = "FRIENDS_OF_SOLANA_2025";
    const codeHash = Array.from(crypto.createHash("sha256").update(rawCode).digest());

    const [referrerAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer"), campaignPolicyPda.toBuffer(), referrerWallet.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .registerReferrer(codeHash)
      .accounts({
        referrer: referrerWallet.publicKey,
        campaignPolicy: campaignPolicyPda,
        referrerAccount: referrerAccountPda,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([referrerWallet])
      .rpc();

    const referrerRecord = await program.account.referrerAccount.fetch(referrerAccountPda);
    assert.equal(referrerRecord.owner.toBase58(), referrerWallet.publicKey.toBase58());
    assert.equal(referrerRecord.totalReferrals.toNumber(), 0);
    assert.equal(referrerRecord.tierLevel, 1);
  });

  it("3. Executes Claim Referral with Tier-3 (1.5x Multiplier) Settled Atomically", async () => {
    const segmentTier = 3; // 1.5x base reward multiplier

    const [referrerAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer"), campaignPolicyPda.toBuffer(), referrerWallet.publicKey.toBuffer()],
      program.programId
    );

    const [refereeRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referee"), campaignPolicyPda.toBuffer(), refereeWallet.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .claimReferral(segmentTier)
      .accounts({
        referee: refereeWallet.publicKey,
        referrerUser: referrerWallet.publicKey,
        campaignPolicy: campaignPolicyPda,
        referrerAccount: referrerAccountPda,
        refereeRecord: refereeRecordPda,
        rewardVault: rewardVaultPda,
        referrerTokenAccount: referrerTokenAccount,
        refereeTokenAccount: refereeTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([refereeWallet])
      .rpc();

    // Check on-chain balances:
    // Base = 10,000,000 * 1.5 = 15,000,000
    // Referrer (10%) = 1,500,000
    // Referee (5%) = 750,000
    const referrerAta = await getAccount(provider.connection, referrerTokenAccount);
    const refereeAta = await getAccount(provider.connection, refereeTokenAccount);

    assert.equal(referrerAta.amount.toString(), "1500000");
    assert.equal(refereeAta.amount.toString(), "750000");

    const referrerState = await program.account.referrerAccount.fetch(referrerAccountPda);
    assert.equal(referrerState.totalReferrals.toNumber(), 1);
    assert.equal(referrerState.totalEarnings.toString(), "1500000");

    const refereeState = await program.account.refereeRecord.fetch(refereeRecordPda);
    assert.isTrue(refereeState.claimed);
    assert.equal(refereeState.segmentTier, segmentTier);
  });

  it("4. Rejects Self-Referral Exploits with Error", async () => {
    const [referrerAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer"), campaignPolicyPda.toBuffer(), referrerWallet.publicKey.toBuffer()],
      program.programId
    );

    const [refereeRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referee"), campaignPolicyPda.toBuffer(), referrerWallet.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .claimReferral(1)
        .accounts({
          referee: referrerWallet.publicKey,
          referrerUser: referrerWallet.publicKey,
          campaignPolicy: campaignPolicyPda,
          referrerAccount: referrerAccountPda,
          refereeRecord: refereeRecordPda,
          rewardVault: rewardVaultPda,
          referrerTokenAccount: referrerTokenAccount,
          refereeTokenAccount: referrerTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([referrerWallet])
        .rpc();
      assert.fail("Should have thrown SelfReferralForbidden error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SelfReferralForbidden");
    }
  });

  it("5. Rejects Duplicate Claims by Same Referee", async () => {
    const [referrerAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer"), campaignPolicyPda.toBuffer(), referrerWallet.publicKey.toBuffer()],
      program.programId
    );

    const [refereeRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referee"), campaignPolicyPda.toBuffer(), refereeWallet.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .claimReferral(2)
        .accounts({
          referee: refereeWallet.publicKey,
          referrerUser: referrerWallet.publicKey,
          campaignPolicy: campaignPolicyPda,
          referrerAccount: referrerAccountPda,
          refereeRecord: refereeRecordPda,
          rewardVault: rewardVaultPda,
          referrerTokenAccount: referrerTokenAccount,
          refereeTokenAccount: refereeTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([refereeWallet])
        .rpc();
      assert.fail("Should have failed to re-initialize an existing RefereeRecord PDA");
    } catch (err: any) {
      // Account already exists in Anchor runtime
      assert.ok(err.toString().includes("already in use") || err.toString().includes("custom program error: 0x0"));
    }
  });
});