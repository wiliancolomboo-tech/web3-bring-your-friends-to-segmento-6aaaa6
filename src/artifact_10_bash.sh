# 1. Build Solana Anchor Program
anchor build

# 2. Deploy Program to Solana Devnet (or Mainnet)
solana program deploy \
  --program-id target/deploy/segmento_referral-keypair.json \
  target/deploy/segmento_referral.so \
  --url devnet

# 3. Export IDL and Generate Types
anchor idl init --filepath target/idl/segmento_referral.json $(solana address -k target/deploy/segmento_referral-keypair.json) --url devnet

# 4. Launch Enterprise Worker Daemon via Docker
docker compose up -d --build

# 5. Monitor Daemon Logs
docker compose logs -f segmento-growth-daemon