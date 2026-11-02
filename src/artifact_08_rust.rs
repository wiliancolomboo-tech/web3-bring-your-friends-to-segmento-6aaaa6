use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::CampaignPolicy;
use crate::errors::SegmentoError;
use crate::events::CampaignInitialized;

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct InitializeCampaign<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        space = CampaignPolicy::LEN,
        seeds = [b"campaign", campaign_id.to_le_bytes().as_ref()],
        bump
    )]
    pub campaign_policy: Account<'info, CampaignPolicy>,

    #[account(
        init,
        payer = authority,
        seeds = [b"vault", campaign_policy.key().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = campaign_policy,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(
    ctx: Context<InitializeCampaign>,
    campaign_id: u64,
    referrer_bps: u16,
    referee_bps: u16,
    base_reward_amount: u64,
) -> Result<()> {
    require!(
        referrer_bps.checked_add(referee_bps).unwrap_or(u16::MAX) <= 10_000,
        SegmentoError::InvalidBasisPoints
    );

    let campaign = &mut ctx.accounts.campaign_policy;
    campaign.authority = ctx.accounts.authority.key();
    campaign.reward_mint = ctx.accounts.reward_mint.key();
    campaign.vault = ctx.accounts.reward_vault.key();
    campaign.campaign_id = campaign_id;
    campaign.referrer_bps = referrer_bps;
    campaign.referee_bps = referee_bps;
    campaign.base_reward_amount = base_reward_amount;
    campaign.is_active = true;
    campaign.total_referred_users = 0;
    campaign.total_distributed = 0;
    campaign.bump = ctx.bumps.campaign_policy;
    campaign.vault_bump = ctx.bumps.reward_vault;

    emit!(CampaignInitialized {
        campaign_id,
        authority: campaign.authority,
        reward_mint: campaign.reward_mint,
        referrer_bps,
        referee_bps,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}