use anchor_lang::prelude::*;
use crate::state::{CampaignPolicy, ReferrerAccount};
use crate::errors::SegmentoError;
use crate::events::ReferrerRegistered;

#[derive(Accounts)]
pub struct RegisterReferrer<'info> {
    #[account(mut)]
    pub referrer: Signer<'info>,

    #[account(
        seeds = [b"campaign", campaign_policy.campaign_id.to_le_bytes().as_ref()],
        bump = campaign_policy.bump,
        constraint = campaign_policy.is_active @ SegmentoError::CampaignInactive
    )]
    pub campaign_policy: Account<'info, CampaignPolicy>,

    #[account(
        init,
        payer = referrer,
        space = ReferrerAccount::LEN,
        seeds = [b"referrer", campaign_policy.key().as_ref(), referrer.key().as_ref()],
        bump
    )]
    pub referrer_account: Account<'info, ReferrerAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterReferrer>,
    code_hash: [u8; 32],
) -> Result<()> {
    let referrer_acc = &mut ctx.accounts.referrer_account;
    referrer_acc.owner = ctx.accounts.referrer.key();
    referrer_acc.campaign = ctx.accounts.campaign_policy.key();
    referrer_acc.total_referrals = 0;
    referrer_acc.total_earnings = 0;
    referrer_acc.tier_level = 1; // Tier 1 by default
    referrer_acc.code_hash = code_hash;
    referrer_acc.bump = ctx.bumps.referrer_account;

    emit!(ReferrerRegistered {
        referrer: referrer_acc.owner,
        campaign_id: ctx.accounts.campaign_policy.campaign_id,
        custom_code_hash: code_hash,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}