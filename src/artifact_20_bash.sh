# 1. Build optimized BPF program
anchor build

# 2. Deploy to Solana Devnet (or Mainnet-beta)
solana program deploy \
  --program-id target/deploy/segmento_referrals-keypair.json \
  target/deploy/segmento_referrals.so \
  --url devnet

# 3. Initialize protocol parameters and link reward escrow vault
npx ts-node scripts/init-platform.ts