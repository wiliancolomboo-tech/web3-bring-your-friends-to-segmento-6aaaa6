# 1. Build and compile Anchor program
anchor build

# 2. Get Program ID
solana address -k target/deploy/segmento_referral-keypair.json

# 3. Synchronize program ID in Anchor.toml & programs/segmento-referral/src/lib.rs
# 4. Deploy to Solana Devnet
anchor deploy --provider.cluster devnet

# 5. Initialize config via CLI
npx ts-node scripts/init-platform.ts --cluster devnet

# 6. Run the Enterprise Integration Daemon
docker-compose up -d --build