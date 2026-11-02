# Build the Solana program bytecode and generate IDL
anchor build

# Get Program ID and sync keys
solana address -k target/deploy/segmento_referral-keypair.json
anchor keys sync