import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SegmentoReferrals } from "../target/types/segmento_referrals";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("segmento-referrals test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SegmentoReferrals as Program<SegmentoReferrals>;

  let rewardMint: PublicKey;
  let admin = (provider.wallet as anchor.Wallet).payer;
  let oracleVerifier = Keypair.generate();
  let aliceReferrer = Keypair.generate();
  let bobReferee = Keypair.generate();
  let charlieReferee = Keypair.generate();

  let aliceTokenAccount: PublicKey;
  let configPda: PublicKey;
  let vaultPda: PublicKey;

  const BASE_REWARD = new anchor.BN(50_000_000); // 50 Tokens

  before(async () => {
    // Air-drop funds to keypairs
    for (const kp of [oracleVerifier, aliceReferrer, bobReferee, charlieReferee]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create reward mint
    rewardMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Derive PDAs
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("segmento_config")],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("segmento_vault"), rewardMint.toBuffer()],
      program.programId
    );

    aliceTokenAccount = await createAccount(
      provider.connection,
      aliceReferrer,
      rewardMint,
      aliceReferrer.publicKey
    );
  });

  it("1. Initializes Global Configuration & Vault Escrow", async () => {
    await program.methods
      .initializeConfig(BASE_REWARD)
      .accounts({
        admin: admin.publicKey,
        oracleVerifier: oracleVerifier.publicKey,
        rewardMint: rewardMint,
        config: configPda,
        vault: vaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: anchor.spl.token.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const configAccount = await program.account.globalConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.oracleVerifier.toBase58()).to.equal(oracleVerifier.publicKey.toBase58());
    expect(configAccount.baseMilestoneReward.toNumber()).to.equal(BASE_REWARD.toNumber());
    expect(configAccount.isPaused).to.be.false;
  });

  it("2. Funds Vault Escrow with SPL Tokens", async () => {
    const adminTokenAccount = await createAccount(
      provider.connection,
      admin,
      rewardMint,
      admin.publicKey
    );

    await mintTo(
      provider.connection,
      admin,
      rewardMint,
      adminTokenAccount,
      admin,
      1_000_000_000 // 1000 Tokens
    );

    await program.methods
      .fundVault(new anchor.BN(500_000_000))
      .accounts({
        funder: admin.publicKey,
        config: configPda,
        vault: vaultPda,
        funderTokenAccount: adminTokenAccount,
        tokenProgram: anchor.spl.token.TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultBalance = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultBalance.amount)).to.equal(500_000_000);
  });

  it("3. Registers Alice as a Referrer Profile", async () => {
    const [aliceProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer_profile"), aliceReferrer.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .registerReferrer("ALICE_VIP")
      .accounts({
        referrer: aliceReferrer.publicKey,
        config: configPda,
        referrerProfile: aliceProfilePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([aliceReferrer])
      .rpc();

    const profile = await program.account.referrerProfile.fetch(aliceProfilePda);
    expect(profile.referralCode).to.equal("ALICE_VIP");
    expect(profile.totalInvites).to.equal(0);
    expect(profile.tier).to.equal(0);
    expect(profile.isActive).to.be.true;
  });

  it("4. Binds Bob as Referee to Alice with Valid Oracle Attestation", async () => {
    const [aliceProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer_profile"), aliceReferrer.publicKey.toBuffer()],
      program.programId
    );

    const [bobAttestationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referee_attestation"), bobReferee.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .bindReferral(1) // Cohort 1: Trader
      .accounts({
        referee: bobReferee.publicKey,
        config: configPda,
        referrerProfile: aliceProfilePda,
        refereeAttestation: bobAttestationPda,
        oracleVerifier: oracleVerifier.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([bobReferee, oracleVerifier])
      .rpc();

    const attestation = await program.account.refereeAttestation.fetch(bobAttestationPda);
    expect(attestation.referrer.toBase58()).to.equal(aliceReferrer.publicKey.toBase58());
    expect(attestation.cohortTag).to.equal(1);
    expect(attestation.rewardPaid).to.be.false;

    const profile = await program.account.referrerProfile.fetch(aliceProfilePda);
    expect(profile.totalInvites).to.equal(1);
  });

  it("5. Rejects Self-Referral Invariant", async () => {
    const [aliceProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer_profile"), aliceReferrer.publicKey.toBuffer()],
      program.programId
    );

    const [aliceSelfAttestation] = PublicKey.findProgramAddressSync(
      [Buffer.from("referee_attestation"), aliceReferrer.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .bindReferral(0)
        .accounts({
          referee: aliceReferrer.publicKey,
          config: configPda,
          referrerProfile: aliceProfilePda,
          refereeAttestation: aliceSelfAttestation,
          oracleVerifier: oracleVerifier.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([aliceReferrer, oracleVerifier])
        .rpc();
      expect.fail("Self-referral should have been rejected!");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("CannotReferSelf");
    }
  });

  it("6. Rejects Bind When Oracle Signer Is Spoofed", async () => {
    const fakeOracle = Keypair.generate();
    const [aliceProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer_profile"), aliceReferrer.publicKey.toBuffer()],
      program.programId
    );

    const [charlieAttestationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referee_attestation"), charlieReferee.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .bindReferral(0)
        .accounts({
          referee: charlieReferee.publicKey,
          config: configPda,
          referrerProfile: aliceProfilePda,
          refereeAttestation: charlieAttestationPda,
          oracleVerifier: fakeOracle.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([charlieReferee, fakeOracle])
        .rpc();
      expect.fail("Spoofed oracle signer must fail!");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("Unauthorized");
    }
  });

  it("7. Executes Verified Milestone Claim and Transfers Escrow Reward", async () => {
    const [aliceProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer_profile"), aliceReferrer.publicKey.toBuffer()],
      program.programId
    );

    const [bobAttestationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referee_attestation"), bobReferee.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .claimReward(1) // Milestone 1 reached
      .accounts({
        caller: admin.publicKey,
        config: configPda,
        referrerProfile: aliceProfilePda,
        refereeAttestation: bobAttestationPda,
        vault: vaultPda,
        referrerTokenAccount: aliceTokenAccount,
        oracleVerifier: oracleVerifier.publicKey,
        tokenProgram: anchor.spl.token.TOKEN_PROGRAM_ID,
      })
      .signers([admin, oracleVerifier])
      .rpc();

    // Verify Alice received her tokens
    const aliceBalance = await getAccount(provider.connection, aliceTokenAccount);
    expect(Number(aliceBalance.amount)).to.equal(BASE_REWARD.toNumber());

    // Verify Bob's attestation is marked paid
    const attestation = await program.account.refereeAttestation.fetch(bobAttestationPda);
    expect(attestation.rewardPaid).to.be.true;

    // Verify Referrer Profile updated
    const profile = await program.account.referrerProfile.fetch(aliceProfilePda);
    expect(profile.totalQualifiedInvites).to.equal(1);
    expect(profile.accruedRewards.toNumber()).to.equal(BASE_REWARD.toNumber());
  });

  it("8. Prevents Double-Claim on Already Paid Attestation", async () => {
    const [aliceProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referrer_profile"), aliceReferrer.publicKey.toBuffer()],
      program.programId
    );

    const [bobAttestationPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referee_attestation"), bobReferee.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .claimReward(1)
        .accounts({
          caller: admin.publicKey,
          config: configPda,
          referrerProfile: aliceProfilePda,
          refereeAttestation: bobAttestationPda,
          vault: vaultPda,
          referrerTokenAccount: aliceTokenAccount,
          oracleVerifier: oracleVerifier.publicKey,
          tokenProgram: anchor.spl.token.TOKEN_PROGRAM_ID,
        })
        .signers([admin, oracleVerifier])
        .rpc();
      expect.fail("Double claiming must be prevented!");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("MilestoneNotMet");
    }
  });
});