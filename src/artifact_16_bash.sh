# 1. Build and verify artifacts
anchor build

# 2. Deploy Anchor Program to Solana Devnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 3. Initialize Campaign via Anchor CLI
npx ts-node client/src/cli.ts init-campaign \
  --campaign-id 1 \
  --referrer-bps 1000 \
  --referee-bps 500 \
  --base-reward 10000000