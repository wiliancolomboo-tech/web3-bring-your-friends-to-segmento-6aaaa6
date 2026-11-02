# 1. Clone repository and install dependencies
git clone https://github.com/segmento-protocol/bring-your-friends.git
cd bring-your-friends
npm install

# 2. Build Anchor Smart Contract
anchor build

# 3. Deploy to Solana Devnet / Mainnet
solana config set --url https://api.devnet.solana.com
solana airdrop 2
anchor deploy --provider.cluster devnet

# 4. Initialize Protocol
anchor run initialize