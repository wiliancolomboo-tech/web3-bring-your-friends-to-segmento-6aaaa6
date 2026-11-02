use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{CampaignPolicy, ReferrerAccount, RefereeRecord};
use crate::errors::SegmentoError;
use crate::events::ReferralClaimed;

#[derive(Accounts)]
pub struct ClaimReferral<'info> {
    #[account(mut)]
    pub referee: Signer<'info>,

    /// CHECK: Validated against referrer_account.owner
    pub referrer_user: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"campaign", campaign_policy.campaign_id.to_le_bytes().as_ref()],
        bump = campaign_policy.bump,
        constraint = campaign_policy.is_active @ SegmentoError::CampaignInactive
    )]
    pub campaign_policy: Account<'info, CampaignPolicy>,

    #[account(
        mut,
        seeds = [b"referrer", campaign_policy.key().as_ref(), referrer_user.key().as_ref()],
        bump = referrer_account.bump,
        constraint = referrer_account.owner == referrer_user.key() @ SegmentoError::Unauthorized
    )]
    pub referrer_account: Account<'info, ReferrerAccount>,

    #[account(
        init,
        payer = referee,
        space = RefereeRecord::LEN,
        seeds = [b"referee", campaign_policy.key().as_ref(), referee.key().as_ref()],
        bump
    )]
    pub referee_record: Account<'info, RefereeRecord>,

    #[account(
        mut,
        seeds = [b"vault", campaign_policy.key().as_ref()],
        bump = campaign_policy.vault_bump,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = referrer_token_account.owner == referrer_user.key(),
        constraint = referrer_token_account.mint == campaign_policy.reward_mint
    )]
    pub referrer_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = referee_token_account.owner == referee.key(),
        constraint = referee_token_account.mint == campaign_policy.reward_mint
    )]
    pub referee_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<ClaimReferral>,
    segment_tier: u8,
) -> Result<()> {
    require!(
        ctx.accounts.referee.key() != ctx.accounts.referrer_user.key(),
        SegmentoError::SelfReferralForbidden
    );
    require!(segment_tier > 0 && segment_tier <= 5, SegmentoError::SegmentCriteriaNotMet);

    let campaign = &ctx.accounts.campaign_policy;
    let base = campaign.base_reward_amount;

    // Segment Tier Multiplier: Tier 1 = 1.0x, Tier 2 = 1.2x, Tier 3 = 1.5x, Tier 4 = 1.8x, Tier 5 = 2.0x
    let tier_multiplier_bps: u64 = match segment_tier {
        1 => 10_000,
        2 => 12_000,
        3 => 15_000,
        4 => 18_000,
        5 => 20_000,
        _ => return err!(SegmentoError::SegmentCriteriaNotMet),
    };

    let effective_base = (base as u128)
        .checked_mul(tier_multiplier_bps as u128)
        .ok_or(SegmentoError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(SegmentoError::MathOverflow)? as u64;

    let referrer_payout = (effective_base as u128)
        .checked_mul(campaign.referrer_bps as u128)
        .ok_or(SegmentoError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(SegmentoError::MathOverflow)? as u64;

    let referee_payout = (effective_base as u128)
        .checked_mul(campaign.referee_bps as u128)
        .ok_or(SegmentoError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(SegmentoError::MathOverflow)? as u64;

    let total_required = referrer_payout
        .checked_add(referee_payout)
        .ok_or(SegmentoError::MathOverflow)?;

    require!(
        ctx.accounts.reward_vault.amount >= total_required,
        SegmentoError::ReferralQuotaExceeded
    );

    // Bind seeds for PDA signing
    let campaign_id_bytes = campaign.campaign_id.to_le_bytes();
    let campaign_seeds: &[&[u8]] = &[
        b"campaign",
        campaign_id_bytes.as_ref(),
        &[campaign.bump],
    ];
    let signer_seeds = &[&campaign_seeds[..]];

    // Transfer rewards to Referrer
    if referrer_payout > 0 {
        let transfer_referrer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.reward_vault.to_account_info(),
                to: ctx.accounts.referrer_token_account.to_account_info(),
                authority: ctx.accounts.campaign_policy.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_referrer_ctx, referrer_payout)?;
    }

    // Transfer rewards to Referee
    if referee_payout > 0 {
        let transfer_referee_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.reward_vault.to_account_info(),
                to: ctx.accounts.referee_token_account.to_account_info(),
                authority: ctx.accounts.campaign_policy.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_referee_ctx, referee_payout)?;
    }

    // Update state
    let referrer_acc = &mut ctx.accounts.referrer_account;
    referrer_acc.total_referrals = referrer_acc
        .total_referrals
        .checked_add(1)
        .ok_or(SegmentoError::MathOverflow)?;
    referrer_acc.total_earnings = referrer_acc
        .total_earnings
        .checked_add(referrer_payout)
        .ok_or(SegmentoError::MathOverflow)?;

    let referee_record = &mut ctx.accounts.referee_record;
    referee_record.referee = ctx.accounts.referee.key();
    referee_record.referrer = ctx.accounts.referrer_user.key();
    referee_record.campaign = ctx.accounts.campaign_policy.key();
    referee_record.claimed = true;
    referee_record.claimed_at = Clock::get()?.unix_timestamp;
    referee_record.segment_tier = segment_tier;
    referee_record.bump = ctx.bumps.referee_record;

    let campaign_mut = &mut ctx.accounts.campaign_policy;
    campaign_mut.total_referred_users = campaign_mut
        .total_referred_users
        .checked_add(1)
        .ok_or(SegmentoError::MathOverflow)?;
    campaign_mut.total_distributed = campaign_mut
        .total_distributed
        .checked_add(total_required)
        .ok_or(SegmentoError::MathOverflow)?;

    emit!(ReferralClaimed {
        campaign_id: campaign_mut.campaign_id,
        referrer: ctx.accounts.referrer_user.key(),
        referee: ctx.accounts.referee.key(),
        referrer_reward: referrer_payout,
        referee_reward: referee_payout,
        segment_tier,
        timestamp: referee_record.claimed_at,
    });

    Ok(())
}