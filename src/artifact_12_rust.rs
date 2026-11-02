use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("SegmXzB8q9WJtK3vY1qQn8g5mH3z8J2XqYn9g5mH3z8");

#[program]
pub mod segmento_referral {
    use super::*;

    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        campaign_id: u64,
        referrer_bps: u16,
        referee_bps: u16,
        base_reward_amount: u64,
    ) -> Result<()> {
        instructions::initialize_campaign::handler(
            ctx,
            campaign_id,
            referrer_bps,
            referee_bps,
            base_reward_amount,
        )
    }

    pub fn register_referrer(
        ctx: Context<RegisterReferrer>,
        code_hash: [u8; 32],
    ) -> Result<()> {
        instructions::register_referrer::handler(ctx, code_hash)
    }

    pub fn claim_referral(
        ctx: Context<ClaimReferral>,
        segment_tier: u8,
    ) -> Result<()> {
        instructions::claim_referral::handler(ctx, segment_tier)
    }
}