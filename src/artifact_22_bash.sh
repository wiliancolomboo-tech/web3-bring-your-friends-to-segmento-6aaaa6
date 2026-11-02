# Retrieve generated program key
solana address -k target/deploy/segmento_referral-keypair.json

# Sync Anchor keys and deploy to Devnet
anchor keys sync
anchor deploy --provider.cluster devnet --provider.wallet deployer-keypair.json