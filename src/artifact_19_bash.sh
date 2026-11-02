# 1. Clone & Build Solana Program
anchor build

# 2. Synchronize Program ID
solana address -k target/deploy/segmento_referral-keypair.json
# Ensure ID matches declare_id!() in src/lib.rs

# 3. Deploy to Solana Devnet
anchor deploy --provider.cluster devnet

# 4. Run Test Suite
anchor test --skip-local-validator