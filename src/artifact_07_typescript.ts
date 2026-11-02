import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SegmentoReferral } from "../target/types/segmento_referral";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

describe("segmento-referral end-to-end lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SegmentoReferral as Program<SegmentoReferral>;

  const authority = (provider.wallet as any).payer as Keypair;
  const aliceReferrer = Keypair.generate();
  const bobReferee = Keypair.generate();
  const charlieAttacker = Keypair.generate();

  let configPda: PublicKey;
  let vaultPda: PublicKey;
  let aliceReferralPda: PublicKey;
  let bobBindingPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [aliceReferrer, bobReferee, charlieAttacker]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 5 * LAMPORTS_PER_SOL);
      const latestBlockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({
        signature: sig,
        ...latestBlockhash,
      });
    }

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("segmento_config")],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow_vault"), configPda.toBuffer()],
      program.programId
    );

    [aliceReferralPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referral_state"), aliceReferrer.publicKey.toBuffer()],
      program.programId
    );

    [bobBindingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("referee_binding"), bobReferee.publicKey.toBuffer()],
      program.programId
    );
  });

  it("1. Successfully initializes the Segmento Global Config and Escrow Vault", async () => {
    const basisPoints = 500; // 5%
    const milestoneThreshold = new anchor.BN(1 * LAMPORTS_PER_SOL);

    await program.methods
      .initializeConfig(basisPoints, milestoneThreshold)
      .accounts({
        config: configPda,
        escrow_vault: vaultPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const configAccount = await program.account.globalConfig.fetch(configPda);
    expect(configAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(configAccount.basisPointsCommission).to.equal(basisPoints);
    expect(configAccount.milestoneThresholdLamports.toNumber()).to.equal(1 * LAMPORTS_PER_SOL);
    expect(configAccount.totalRefereesOnboarded.toNumber()).to.equal(0);
  });

  it("2. Funds the Escrow Vault with protocol reward SOL", async () => {
    const fundAmount = new anchor.BN(2 * LAMPORTS_PER_SOL);

    await program.methods
      .fundEscrowVault(fundAmount)
      .accounts({
        config: configPda,
        escrow_vault: vaultPda,
        funder: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const vaultBalance = await provider.connection.getBalance(vaultPda);
    expect(vaultBalance).to.be.at.least(2 * LAMPORTS_PER_SOL);
  });

  it("3. Registers Alice as a legitimate Segmento Referrer", async () => {
    const campaignTag = "solana-global-2025";

    await program.methods
      .registerReferrer(campaignTag)
      .accounts({
        referralState: aliceReferralPda,
        referrer: aliceReferrer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([aliceReferrer])
      .rpc();

    const aliceState = await program.account.referralAccount.fetch(aliceReferralPda);
    expect(aliceState.referrer.toBase58()).to.equal(aliceReferrer.publicKey.toBase58());
    expect(aliceState.campaignTag).to.equal(campaignTag);
    expect(aliceState.totalReferrals.toNumber()).to.equal(0);
    expect(aliceState.totalLamportsEarned.toNumber()).to.equal(0);
  });

  it("4. Prevents Self-Referral (Alice cannot refer Alice)", async () => {
    const [aliceSelfBinding] = PublicKey.findProgramAddressSync(
      [Buffer.from("referee_binding"), aliceReferrer.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .bindReferee()
        .accounts({
          config: configPda,
          referralState: aliceReferralPda,
          refereeBinding: aliceSelfBinding,
          referee: aliceReferrer.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([aliceReferrer])
        .rpc();
      expect.fail("Expected SelfReferralNotAllowed error was not thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SelfReferralNotAllowed");
    }
  });

  it("5. Binds Bob as Alice's referee", async () => {
    await program.methods
      .bindReferee()
      .accounts({
        config: configPda,
        referralState: aliceReferralPda,
        refereeBinding: bobBindingPda,
        referee: bobReferee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([bobReferee])
      .rpc();

    const binding = await program.account.refereeBindingAccount.fetch(bobBindingPda);
    expect(binding.referee.toBase58()).to.equal(bobReferee.publicKey.toBase58());
    expect(binding.referrer.toBase58()).to.equal(aliceReferrer.publicKey.toBase58());
    expect(binding.milestoneCompleted).to.be.false;

    const aliceState = await program.account.referralAccount.fetch(aliceReferralPda);
    expect(aliceState.totalReferrals.toNumber()).to.equal(1);
  });

  it("6. Rejects Bob completing milestone with volume below threshold", async () => {
    const subThresholdVolume = new anchor.BN(0.5 * LAMPORTS_PER_SOL);

    try {
      await program.methods
        .completeMilestone(1, subThresholdVolume)
        .accounts({
          config: configPda,
          escrowVault: vaultPda,
          referralState: aliceReferralPda,
          refereeBinding: bobBindingPda,
          referrerWallet: aliceReferrer.publicKey,
          referee: bobReferee.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([bobReferee])
        .rpc();
      expect.fail("Expected InsufficientVolume error was not thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InsufficientVolume");
    }
  });

  it("7. Successfully completes Bob milestone and disburses commission to Alice", async () => {
    const actionVolume = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const expectedCommission = (1 * LAMPORTS_PER_SOL * 500) / 10000; // 0.05 SOL

    const aliceBalanceBefore = await provider.connection.getBalance(aliceReferrer.publicKey);

    await program.methods
      .completeMilestone(1, actionVolume)
      .accounts({
        config: configPda,
        escrowVault: vaultPda,
        referralState: aliceReferralPda,
        refereeBinding: bobBindingPda,
        referrerWallet: aliceReferrer.publicKey,
        referee: bobReferee.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([bobReferee])
      .rpc();

    const aliceBalanceAfter = await provider.connection.getBalance(aliceReferrer.publicKey);
    expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(expectedCommission);

    const binding = await program.account.refereeBindingAccount.fetch(bobBindingPda);
    expect(binding.milestoneCompleted).to.be.true;

    const aliceState = await program.account.referralAccount.fetch(aliceReferralPda);
    expect(aliceState.totalLamportsEarned.toNumber()).to.equal(expectedCommission);
  });

  it("8. Prevents double-spending on duplicate milestone claim", async () => {
    const actionVolume = new anchor.BN(1 * LAMPORTS_PER_SOL);

    try {
      await program.methods
        .completeMilestone(1, actionVolume)
        .accounts({
          config: configPda,
          escrowVault: vaultPda,
          referralState: aliceReferralPda,
          refereeBinding: bobBindingPda,
          referrerWallet: aliceReferrer.publicKey,
          referee: bobReferee.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([bobReferee])
        .rpc();
      expect.fail("Expected MilestoneAlreadyCompleted error was not thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("MilestoneAlreadyCompleted");
    }
  });
});