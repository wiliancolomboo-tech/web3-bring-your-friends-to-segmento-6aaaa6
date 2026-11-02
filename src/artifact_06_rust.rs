use anchor_lang::prelude::*;

#[event]
pub struct CampaignInitialized {
    pub campaign_id: u64,
    pub authority: Pubkey,
    pub reward_mint: Pubkey,
    pub referrer_bps: u16,
    pub referee_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct ReferrerRegistered {
    pub referrer: Pubkey,
    pub campaign_id: u64,
    pub custom_code_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct ReferralClaimed {
    pub campaign_id: u64,
    pub referrer: Pubkey,
    pub referee: Pubkey,
    pub referrer_reward: u64,
    pub referee_reward: u64,
    pub segment_tier: u8,
    pub timestamp: i64,
}