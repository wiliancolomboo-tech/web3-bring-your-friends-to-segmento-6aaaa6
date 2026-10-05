# Set Solana cluster target (devnet or mainnet-beta)
solana config set --url devnet

# Build Rust Anchor binary
anchor build

# Deploy program
anchor deploy --program-name segmento_referrals

# Sync program ID to Anchor.toml and src/lib.rs if new keypair generated