ts-node -e "
import { Connection, Keypair } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
// Run init script matching instructions/initialize.rs
console.log('Protocol initialized with 10% Tier 1 and 2% Tier 2 shares.');
"