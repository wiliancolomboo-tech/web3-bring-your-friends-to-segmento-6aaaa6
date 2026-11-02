solana config set --url https://api.devnet.solana.com
solana-keygen new -o deployer-keypair.json --no-bip39-passphrase --force
solana airdrop 2 deployer-keypair.json

# Build the Anchor binary
anchor build