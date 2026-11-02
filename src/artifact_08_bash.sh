# 1. Build Solana Program
anchor build

# 2. Get Program ID
solana address -k target/deploy/segmento_referral-keypair.json

# 3. Configure to Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com

# 4. Deploy Program
anchor deploy --provider.cluster devnet

# 5. Initialize Config and Seed Escrow Vault (500 bps = 5%, 1 SOL threshold)
anchor run initialize