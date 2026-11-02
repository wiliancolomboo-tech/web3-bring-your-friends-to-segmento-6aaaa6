use anchor_lang::prelude::*;

pub const DISCRIMINATOR_LENGTH: usize = 8;
pub const MAX_NAME_LENGTH: usize = 32;

#[account]
pub struct CampaignPolicy {
    pub authority: Pubkey,          // 32
    pub reward_mint: Pubkey,        // 32
    pub vault: Pubkey,              // 32
    pub campaign_id: u64,           // 8
    pub referrer_bps: u16,          // 2 (e.g. 500 = 5%)
    pub referee_bps: u16,           // 2 (e.g. 250 = 2.5%)
    pub base_reward_amount: u64,    // 8
    pub is_active: bool,            // 1
    pub total_referred_users: u64,  // 8
    pub total_distributed: u64,     // 8
    pub bump: u8,                   // 1
    pub vault_bump: u8,             // 1
}

impl CampaignPolicy {
    pub const LEN: usize = DISCRIMINATOR_LENGTH
        + 32 + 32 + 32 + 8 + 2 + 2 + 8 + 1 + 8 + 8 + 1 + 1;
}

#[account]
pub struct ReferrerAccount {
    pub owner: Pubkey,              // 32
    pub campaign: Pubkey,           // 32
    pub total_referrals: u64,       // 8
    pub total_earnings: u64,        // 8
    pub tier_level: u8,             // 1
    pub code_hash: [u8; 32],        // 32
    pub bump: u8,                   // 1
}

impl ReferrerAccount {
    pub const LEN: usize = DISCRIMINATOR_LENGTH
        + 32 + 32 + 8 + 8 + 1 + 32 + 1;
}

#[account]
pub struct RefereeRecord {
    pub referee: Pubkey,            // 32
    pub referrer: Pubkey,           // 32
    pub campaign: Pubkey,           // 32
    pub claimed: bool,              // 1
    pub claimed_at: i64,            // 8
    pub segment_tier: u8,           // 1
    pub bump: u8,                   // 1
}

impl RefereeRecord {
    pub const LEN: usize = DISCRIMINATOR_LENGTH
        + 32 + 32 + 32 + 1 + 8 + 1 + 1;
}