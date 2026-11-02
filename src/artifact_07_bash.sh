# 1. Clone repository & install dependencies
git clone https://github.com/segmento-network/bring-friends-to-segmento.git
cd bring-friends-to-segmento
yarn install

# 2. Build Anchor Program
anchor build

# 3. Synchronize Program ID
solana address -k target/deploy/segmento_referral-keypair.json
# (Paste output into declare_id! in lib.rs and Anchor.toml)

# 4. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 5. Execute QA Test Suite
anchor test