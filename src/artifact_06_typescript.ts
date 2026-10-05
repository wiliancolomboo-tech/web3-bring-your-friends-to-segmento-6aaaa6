import { Keypair, PublicKey } from "@solana/web3.js";
import * as nacl from "tweetnacl";
import { createHash } from "crypto";

export class SegmentoOracleSigner {
  private oracleKeypair: Keypair;

  constructor(secretKey: Uint8Array) {
    this.oracleKeypair = Keypair.fromSecretKey(secretKey);
  }

  public getPublicKey(): PublicKey {
    return this.oracleKeypair.publicKey;
  }

  /**
   * Generates a 32-byte sha256 hash and Ed25519 signature for a referral voucher
   * Payload: campaign_id + referrer_pubkey + referred_pubkey
   */
  public issueReferralVoucher(
    campaignId: string,
    referrerPubkey: PublicKey,
    referredPubkey: PublicKey
  ): { msgHash: Buffer; signature: Buffer } {
    const campaignBuffer = Buffer.from(campaignId, "utf-8");
    const referrerBuffer = referrerPubkey.toBuffer();
    const referredBuffer = referredPubkey.toBuffer();

    const payload = Buffer.concat([campaignBuffer, referrerBuffer, referredBuffer]);
    const hash = createHash("sha256").update(payload).digest();

    const signature = nacl.sign.detached(hash, this.oracleKeypair.secretKey);

    return {
      msgHash: hash,
      signature: Buffer.from(signature),
    };
  }
}