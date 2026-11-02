use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("SegmX11111111111111111111111111111111111111");

#[program]
pub mod segmento_referral {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        fee_share_bps: u16,
        secondary_share_bps: u16,
        min_distribution_lamports: u64,
    ) -> Result<()> {
        instructions::initialize::handle(ctx, fee_share_bps, secondary_share_bps, min_distribution_lamports)
    }

    pub fn register_referrer(ctx: Context<RegisterReferrer>, code: String) -> Result<()> {
        instructions::register_referrer::handle(ctx, code)
    }

    pub fn bind_referral(ctx: Context<BindReferral>) -> Result<()> {
        instructions::bind_referral::handle(ctx)
    }

    pub fn distribute_rewards(
        ctx: Context<DistributeRewards>,
        volume_lamports: u64,
        cohort_tag: u8,
    ) -> Result<()> {
        instructions::distribute_rewards::handle(ctx, volume_lamports, cohort_tag)
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        instructions::claim_rewards::handle(ctx)
    }
}