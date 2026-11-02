# Set Solana cluster configuration
solana config set --url https://api.devnet.solana.com

# Build program binary
anchor build

# Sync Program Keypair & ID
solana address -k target/deploy/segmento_referrals-keypair.json
# (Replace declare_id! inside lib.rs with the generated pubkey and re-run anchor build)

# Deploy to Solana Devnet
anchor deploy --provider.cluster devnet