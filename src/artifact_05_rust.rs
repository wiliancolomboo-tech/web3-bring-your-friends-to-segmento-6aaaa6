use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("SegReferraL111111111111111111111111111111111");

pub const CAMPAIGN_SEED: &[u8] = b"campaign";
pub const REFERRAL_SEED: &[u8] = b"referral";
pub const ATTRIBUTION_SEED: &[u8] = b"attribution";
pub const VAULT_SEED: &[u8] = b"reward_vault";

#[program]
pub mod segmento_referral {
    use super::*;

    /// Initializes a new growth campaign with fixed token rewards and tier steps.
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        campaign_id: String,
        referrer_base_reward: u64,
        invitee_reward: u64,
        tier_step: u32,
        tier_bonus_bps: u16,
    ) -> Result<()> {
        require!(campaign_id.len() > 0 && campaign_id.len() <= 32, ErrorCode::InvalidCampaignId);
        require!(referrer_base_reward > 0, ErrorCode::ZeroRewardAmount);
        require!(tier_bonus_bps <= 10_000, ErrorCode::InvalidBonusBps);

        let campaign = &mut ctx.accounts.campaign;
        campaign.admin = ctx.accounts.admin.key();
        campaign.campaign_id = campaign_id;
        campaign.reward_mint = ctx.accounts.reward_mint.key();
        campaign.vault_bump = ctx.bumps.reward_vault;
        campaign.referrer_base_reward = referrer_base_reward;
        campaign.invitee_reward = invitee_reward;
        campaign.tier_step = tier_step;
        campaign.tier_bonus_bps = tier_bonus_bps;
        campaign.total_referrals = 0;
        campaign.total_rewards_distributed = 0;
        campaign.is_paused = false;

        emit!(CampaignInitialized {
            campaign: campaign.key(),
            admin: campaign.admin,
            reward_mint: campaign.reward_mint,
            referrer_base_reward,
            invitee_reward,
        });

        Ok(())
    }

    /// Registers a referral profile for a referrer within a campaign.
    pub fn create_referral_profile(
        ctx: Context<CreateReferralProfile>,
        custom_alias: String,
    ) -> Result<()> {
        require!(custom_alias.len() <= 32, ErrorCode::InvalidAliasLength);

        let profile = &mut ctx.accounts.referral_profile;
        profile.referrer = ctx.accounts.referrer.key();
        profile.campaign = ctx.accounts.campaign.key();
        profile.custom_alias = custom_alias.clone();
        profile.successful_referrals = 0;
        profile.total_earned = 0;
        profile.created_at = Clock::get()?.unix_timestamp;

        emit!(ReferralProfileCreated {
            referrer: profile.referrer,
            campaign: profile.campaign,
            custom_alias,
        });

        Ok(())
    }

    /// Attributes an invitee to a referrer, validating eligibility and distributing rewards.
    pub fn claim_referral(ctx: Context<ClaimReferral>) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        require!(!campaign.is_paused, ErrorCode::CampaignPaused);
        require!(
            ctx.accounts.referrer.key() != ctx.accounts.invitee.key(),
            ErrorCode::SelfReferralForbidden
        );

        let profile = &mut ctx.accounts.referral_profile;
        require!(profile.referrer == ctx.accounts.referrer.key(), ErrorCode::InvalidReferrer);
        require!(profile.campaign == campaign.key(), ErrorCode::CampaignMismatch);

        // Calculate dynamic tiered reward: base_reward * (1 + (tiers * tier_bonus_bps / 10000))
        let tier_multiplier = if campaign.tier_step > 0 {
            profile.successful_referrals / campaign.tier_step
        } else {
            0
        };

        let bonus_fraction = (tier_multiplier as u64)
            .checked_mul(campaign.tier_bonus_bps as u64)
            .ok_or(ErrorCode::MathOverflow)?;

        let tier_bonus = campaign
            .referrer_base_reward
            .checked_mul(bonus_fraction)
            .ok_or(ErrorCode::MathOverflow)?
            / 10_000;

        let total_referrer_reward = campaign
            .referrer_base_reward
            .checked_add(tier_bonus)
            .ok_or(ErrorCode::MathOverflow)?;

        let total_payout = total_referrer_reward
            .checked_add(campaign.invitee_reward)
            .ok_or(ErrorCode::MathOverflow)?;

        require!(
            ctx.accounts.reward_vault.amount >= total_payout,
            ErrorCode::InsufficientVaultBalance
        );

        // Record attribution proof PDA
        let attribution = &mut ctx.accounts.attribution;
        attribution.campaign = campaign.key();
        attribution.referrer = ctx.accounts.referrer.key();
        attribution.invitee = ctx.accounts.invitee.key();
        attribution.attributed_at = Clock::get()?.unix_timestamp;
        attribution.reward_paid = total_referrer_reward;

        // Update profile & campaign metrics
        profile.successful_referrals = profile
            .successful_referrals
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;
        profile.total_earned = profile
            .total_earned
            .checked_add(total_referrer_reward)
            .ok_or(ErrorCode::MathOverflow)?;

        campaign.total_referrals = campaign
            .total_referrals
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;
        campaign.total_rewards_distributed = campaign
            .total_rewards_distributed
            .checked_add(total_payout)
            .ok_or(ErrorCode::MathOverflow)?;

        // Execute CPI token transfers via Vault PDA
        let campaign_key = campaign.key();
        let seeds = &[
            VAULT_SEED,
            campaign_key.as_ref(),
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // 1. Transfer reward to Referrer
        if total_referrer_reward > 0 {
            let referrer_transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reward_vault.to_account_info(),
                    to: ctx.accounts.referrer_token_account.to_account_info(),
                    authority: ctx.accounts.reward_vault.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(referrer_transfer_ctx, total_referrer_reward)?;
        }

        // 2. Transfer reward to Invitee (Welcome Bonus)
        if campaign.invitee_reward > 0 {
            let invitee_transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reward_vault.to_account_info(),
                    to: ctx.accounts.invitee_token_account.to_account_info(),
                    authority: ctx.accounts.reward_vault.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(invitee_transfer_ctx, campaign.invitee_reward)?;
        }

        emit!(ReferralAttributed {
            campaign: campaign.key(),
            referrer: ctx.accounts.referrer.key(),
            invitee: ctx.accounts.invitee.key(),
            referrer_reward: total_referrer_reward,
            invitee_reward: campaign.invitee_reward,
            current_tier: tier_multiplier,
            timestamp: attribution.attributed_at,
        });

        Ok(())
    }

    /// Admin action: fund reward vault
    pub fn pause_campaign(ctx: Context<AdminAuth>, paused: bool) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        campaign.is_paused = paused;
        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(campaign_id: String)]
pub struct InitializeCampaign<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Campaign::INIT_SPACE,
        seeds = [CAMPAIGN_SEED, campaign_id.as_bytes()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, campaign.key().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = reward_vault,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CreateReferralProfile<'info> {
    #[account(
        init,
        payer = referrer,
        space = 8 + ReferralProfile::INIT_SPACE,
        seeds = [REFERRAL_SEED, campaign.key().as_ref(), referrer.key().as_ref()],
        bump
    )]
    pub referral_profile: Account<'info, ReferralProfile>,

    pub campaign: Account<'info, Campaign>,

    #[account(mut)]
    pub referrer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimReferral<'info> {
    #[account(mut)]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [REFERRAL_SEED, campaign.key().as_ref(), referrer.key().as_ref()],
        bump
    )]
    pub referral_profile: Account<'info, ReferralProfile>,

    #[account(
        init,
        payer = invitee,
        space = 8 + AttributionRecord::INIT_SPACE,
        seeds = [ATTRIBUTION_SEED, campaign.key().as_ref(), invitee.key().as_ref()],
        bump
    )]
    pub attribution: Account<'info, AttributionRecord>,

    /// CHECK: Validated against referral_profile.referrer
    #[account(mut)]
    pub referrer: AccountInfo<'info>,

    #[account(mut)]
    pub invitee: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, campaign.key().as_ref()],
        bump = campaign.vault_bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = referrer_token_account.owner == referrer.key() @ ErrorCode::InvalidTokenAccountOwner,
        constraint = referrer_token_account.mint == campaign.reward_mint @ ErrorCode::MintMismatch
    )]
    pub referrer_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = invitee_token_account.owner == invitee.key() @ ErrorCode::InvalidTokenAccountOwner,
        constraint = invitee_token_account.mint == campaign.reward_mint @ ErrorCode::MintMismatch
    )]
    pub invitee_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminAuth<'info> {
    #[account(mut, has_one = admin @ ErrorCode::Unauthorized)]
    pub campaign: Account<'info, Campaign>,
    pub admin: Signer<'info>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Campaign {
    pub admin: Pubkey,
    #[max_len(32)]
    pub campaign_id: String,
    pub reward_mint: Pubkey,
    pub vault_bump: u8,
    pub referrer_base_reward: u64,
    pub invitee_reward: u64,
    pub tier_step: u32,
    pub tier_bonus_bps: u16,
    pub total_referrals: u64,
    pub total_rewards_distributed: u64,
    pub is_paused: bool,
}

#[account]
#[derive(InitSpace)]
pub struct ReferralProfile {
    pub referrer: Pubkey,
    pub campaign: Pubkey,
    #[max_len(32)]
    pub custom_alias: String,
    pub successful_referrals: u32,
    pub total_earned: u64,
    pub created_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct AttributionRecord {
    pub campaign: Pubkey,
    pub referrer: Pubkey,
    pub invitee: Pubkey,
    pub attributed_at: i64,
    pub reward_paid: u64,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct CampaignInitialized {
    pub campaign: Pubkey,
    pub admin: Pubkey,
    pub reward_mint: Pubkey,
    pub referrer_base_reward: u64,
    pub invitee_reward: u64,
}

#[event]
pub struct ReferralProfileCreated {
    pub referrer: Pubkey,
    pub campaign: Pubkey,
    pub custom_alias: String,
}

#[event]
pub struct ReferralAttributed {
    pub campaign: Pubkey,
    pub referrer: Pubkey,
    pub invitee: Pubkey,
    pub referrer_reward: u64,
    pub invitee_reward: u64,
    pub current_tier: u32,
    pub timestamp: i64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Campaign identifier must be between 1 and 32 characters")]
    InvalidCampaignId,
    #[msg("Reward base amount must be greater than zero")]
    ZeroRewardAmount,
    #[msg("Tier bonus basis points cannot exceed 10000 (100%)")]
    InvalidBonusBps,
    #[msg("Custom alias string exceeds allowed limit")]
    InvalidAliasLength,
    #[msg("Campaign is currently paused by admin")]
    CampaignPaused,
    #[msg("Self referral is strictly prohibited")]
    SelfReferralForbidden,
    #[msg("Invalid referrer account for this referral profile")]
    InvalidReferrer,
    #[msg("Campaign mismatch on referral profile")]
    CampaignMismatch,
    #[msg("Reward vault does not have enough balance to disburse")]
    InsufficientVaultBalance,
    #[msg("Arithmetic overflow during reward computation")]
    MathOverflow,
    #[msg("Token account owner does not match recipient address")]
    InvalidTokenAccountOwner,
    #[msg("Token mint does not match campaign reward mint")]
    MintMismatch,
    #[msg("Unauthorized administration attempt")]
    Unauthorized,
}