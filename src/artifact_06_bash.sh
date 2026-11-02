# 1. Install Solana Tool suite v1.18+ and Anchor CLI v0.30.1
sh -c "$(curl -sSfL https://release.solana.com/v1.18.17/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1 && avm use 0.30.1

# 2. Build Smart Contract
anchor build

# 3. Synchronize Program ID
solana address -k target/deploy/segmento_referral-keypair.json
# Replace the program ID in Anchor.toml and programs/segmento_referral/src/lib.rs

# 4. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Run automated validation suite
anchor test