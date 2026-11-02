# Set deployment target
solana config set --url https://api.devnet.solana.com

# Deploy Program
solana program deploy ./target/deploy/segmento_referrals.so

# Initialize Global Configuration (CLI)
ts-node client/src/cli.ts init-config \
  --reward-mint <TOKEN_MINT_ADDRESS> \
  --oracle-verifier <VERIFIER_PUBKEY> \
  --base-reward 50000000