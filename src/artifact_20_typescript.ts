import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SegmentoReferral } from "../target/types/segmento_referral";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("Segmento Nexus Protocol Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SegmentoReferral as Program<SegmentoReferral>;

  const admin = Keypair.generate();
  const aliceReferrer = Keypair.generate();
  const bobReferee = Keypair.generate();
  const charlieAttacker = Keypair.generate();
  const payerRewardSource = Keypair.generate();

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault")], program.programId);

  const [aliceProfilePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("referrer"), aliceReferrer.publicKey.toBuffer()],
    program.programId
  );

  const [bobBindingPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("binding"), bobReferee.publicKey.toBuffer()],
    program.programId
  );

  before(async () => {
    // Airdrop funds to actors
    for (const actor of [admin, aliceReferrer, bobReferee, charlieAttacker, payerRewardSource]) {
      const airdropSig = await provider.connection.requestAirdrop(actor.publicKey, 5 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: airdropSig,
        ...latestBlockhash,
      });
    }
  });

  it("1. Initializes the Global Program Configuration and Escrow Vault", async () => {
    const feeShareBps = 1000; // 10%
    const secondaryShareBps = 200; // 2%
    const minDistribution = new anchor.BN(10_000); // 10,000 lamports

    await program.methods
      .initialize(feeShareBps, secondaryShareBps, minDistribution)
      .accounts({
        config: configPda,
        vault: vaultPda,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.programConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.feeShareBps).to.equal(1000);
    expect(configAccount.secondaryShareBps).to.equal(200);
    expect(configAccount.isPaused).to.be.false;
  });

  it("2. Registers Alice as a verified Referrer with code 'ALICE_ALPHA'", async () => {
    const inviteCode = "ALICE_ALPHA";

    await program.methods
      .registerReferrer(inviteCode)
      .accounts({
        referrerProfile: aliceProfilePda,
        authority: aliceReferrer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([aliceReferrer])
      .rpc();

    const profile = await program.account.referrerProfile.fetch(aliceProfilePda);
    expect(profile.authority.toBase58()).to.equal(aliceReferrer.publicKey.toBase58());
    expect(profile.referralCode).to.equal(inviteCode);
    expect(profile.totalRefereesCount.toNumber()).to.equal(0);
    expect(profile.isActive).to.be.true;
  });

  it("3. Enforces Referral Code Length & Content Validation", async () => {
    const badCode = "A!"; // Too short (< 3 chars) & special character
    const badKeypair = Keypair.generate();
    await provider.connection.requestAirdrop(badKeypair.publicKey, 1 * LAMPORTS_PER_SOL);

    const [badPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer"), badKeypair.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .registerReferrer(badCode)
        .accounts({
          referrerProfile: badPda,
          authority: badKeypair.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([badKeypair])
        .rpc();
      expect.fail("Expected transaction to fail due to invalid referral code");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidReferralCode");
    }
  });

  it("4. Binds Bob (Referee) to Alice (Referrer)", async () => {
    await program.methods
      .bindReferral()
      .accounts({
        config: configPda,
        referralBinding: bobBindingPda,
        referrerProfile: aliceProfilePda,
        referee: bobReferee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([bobReferee])
      .rpc();

    const binding = await program.account.referralBinding.fetch(bobBindingPda);
    expect(binding.referee.toBase58()).to.equal(bobReferee.publicKey.toBase58());
    expect(binding.directReferrer.toBase58()).to.equal(aliceReferrer.publicKey.toBase58());
    expect(binding.segmentCohort).to.equal(0); // Default cohort

    const profile = await program.account.referrerProfile.fetch(aliceProfilePda);
    expect(profile.totalRefereesCount.toNumber()).to.equal(1);
  });

  it("5. Rejects Self-Referral Sybil Attack Attempt", async () => {
    const [selfBindingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("binding"), aliceReferrer.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .bindReferral()
        .accounts({
          config: configPda,
          referralBinding: selfBindingPda,
          referrerProfile: aliceProfilePda,
          referee: aliceReferrer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([aliceReferrer])
        .rpc();
      expect.fail("Self-referral must be prohibited");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SelfReferralProhibited");
    }
  });

  it("6. Distributes Volume Activity and Calculates Escrowed Rewards", async () => {
    const volume = new anchor.BN(1 * LAMPORTS_PER_SOL); // 1 SOL volume
    const cohortTag = 2; // Whale

    // 10% feeShareBps of 1 SOL = 0.1 SOL = 100,000,000 lamports
    await program.methods
      .distributeRewards(volume, cohortTag)
      .accounts({
        config: configPda,
        vault: vaultPda,
        referralBinding: bobBindingPda,
        directReferrerProfile: aliceProfilePda,
        referee: bobReferee.publicKey,
        payer: payerRewardSource.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([bobReferee, payerRewardSource])
      .rpc();

    const profile = await program.account.referrerProfile.fetch(aliceProfilePda);
    expect(profile.accruedRewardsLamports.toNumber()).to.equal(100_000_000);

    const binding = await program.account.referralBinding.fetch(bobBindingPda);
    expect(binding.segmentCohort).to.equal(2);
    expect(binding.lifetimeVolumeLamports.toNumber()).to.equal(1 * LAMPORTS_PER_SOL);
  });

  it("7. Allows Referrer Alice to Claim Accumulated Rewards", async () => {
    const preAliceBalance = await provider.connection.getBalance(aliceReferrer.publicKey);

    await program.methods
      .claimRewards()
      .accounts({
        config: configPda,
        vault: vaultPda,
        referrerProfile: aliceProfilePda,
        authority: aliceReferrer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([aliceReferrer])
      .rpc();

    const postAliceBalance = await provider.connection.getBalance(aliceReferrer.publicKey);
    expect(postAliceBalance).to.be.above(preAliceBalance);

    const profile = await program.account.referrerProfile.fetch(aliceProfilePda);
    expect(profile.claimedRewardsLamports.toNumber()).to.equal(100_000_000);
  });

  it("8. Rejects Duplicate Zero-Balance Claim Attempts", async () => {
    try {
      await program.methods
        .claimRewards()
        .accounts({
          config: configPda,
          vault: vaultPda,
          referrerProfile: aliceProfilePda,
          authority: aliceReferrer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([aliceReferrer])
        .rpc();
      expect.fail("Expected zero-balance claim to fail");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InsufficientRewardBalance");
    }
  });
});