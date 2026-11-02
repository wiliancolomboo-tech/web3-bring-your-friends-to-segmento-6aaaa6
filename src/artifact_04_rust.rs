use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("SegmR11111111111111111111111111111111111111");

#[program]
pub mod segmento_referral {
    use super::*;

    /// Initialize a brand-new global growth campaign with custom basis-point splits.
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        campaign_name: String,
        referrer_bps: u16,
        referee_rebate_bps: u16,
        min_qualifying_deposit: u64,
    ) -> Result<()> {
        require!(campaign_name.len() <= 32, ReferralError::NameTooLong);
        require!(
            referrer_bps.checked_add(referee_rebate_bps).unwrap_or(u16::MAX) <= 10_000,
            ReferralError::InvalidBpsAllocation
        );

        let campaign = &mut ctx.accounts.campaign;
        campaign.authority = ctx.accounts.authority.key();
        campaign.mint = ctx.accounts.mint.key();
        campaign.vault = ctx.accounts.vault.key();
        campaign.campaign_name = campaign_name;
        campaign.referrer_bps = referrer_bps;
        campaign.referee_rebate_bps = referee_rebate_bps;
        campaign.min_qualifying_deposit = min_qualifying_deposit;
        campaign.total_referrals = 0;
        campaign.total_volume = 0;
        campaign.bump = ctx.bumps.campaign;
        campaign.vault_bump = ctx.bumps.vault;

        emit!(CampaignInitializedEvent {
            campaign: campaign.key(),
            authority: campaign.authority,
            mint: campaign.mint,
            referrer_bps,
            referee_rebate_bps,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Register a user as a verified Segmento referrer.
    pub fn register_referrer(ctx: Context<RegisterReferrer>) -> Result<()> {
        let referrer_profile = &mut ctx.accounts.referrer_profile;
        referrer_profile.referrer = ctx.accounts.referrer.key();
        referrer_profile.campaign = ctx.accounts.campaign.key();
        referrer_profile.total_referred_users = 0;
        referrer_profile.total_rewards_earned = 0;
        referrer_profile.tier = 1;
        referrer_profile.bump = ctx.bumps.referrer_profile;

        emit!(ReferrerRegisteredEvent {
            campaign: ctx.accounts.campaign.key(),
            referrer: ctx.accounts.referrer.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Claim and link an invitation from a referrer to a referee.
    pub fn accept_referral(ctx: Context<AcceptReferral>) -> Result<()> {
        require!(
            ctx.accounts.referee.key() != ctx.accounts.referrer.key(),
            ReferralError::SelfReferralNotPermitted
        );

        let referral_record = &mut ctx.accounts.referral_record;
        referral_record.campaign = ctx.accounts.campaign.key();
        referral_record.referrer = ctx.accounts.referrer.key();
        referral_record.referee = ctx.accounts.referee.key();
        referral_record.has_completed_qualifying_action = false;
        referral_record.joined_at = Clock::get()?.unix_timestamp;
        referral_record.bump = ctx.bumps.referral_record;

        let referrer_profile = &mut ctx.accounts.referrer_profile;
        referrer_profile.total_referred_users = referrer_profile
            .total_referred_users
            .checked_add(1)
            .ok_or(ReferralError::MathOverflow)?;

        // Tier promotion logic: 5 referrals upgrades to Tier 2, 25 upgrades to Tier 3
        if referrer_profile.total_referred_users >= 25 {
            referrer_profile.tier = 3;
        } else if referrer_profile.total_referred_users >= 5 {
            referrer_profile.tier = 2;
        }

        emit!(ReferralAcceptedEvent {
            campaign: ctx.accounts.campaign.key(),
            referrer: ctx.accounts.referrer.key(),
            referee: ctx.accounts.referee.key(),
            current_tier: referrer_profile.tier,
            timestamp: referral_record.joined_at,
        });

        Ok(())
    }

    /// Deposit funds into campaign vault to execute qualifying action & stream instant rewards.
    pub fn execute_qualifying_action(
        ctx: Context<ExecuteQualifyingAction>,
        deposit_amount: u64,
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let referral_record = &mut ctx.accounts.referral_record;
        let referrer_profile = &mut ctx.accounts.referrer_profile;

        require!(
            deposit_amount >= campaign.min_qualifying_deposit,
            ReferralError::DepositBelowThreshold
        );
        require!(
            !referral_record.has_completed_qualifying_action,
            ReferralError::ActionAlreadyCompleted
        );

        // 1. Transfer gross deposit from referee to campaign vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.referee_token_account.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.referee.to_account_info(),
                },
            ),
            deposit_amount,
        )?;

        // 2. Calculate tier-boosted splits
        // Tier 1: 100% of referrer_bps; Tier 2: 125%; Tier 3: 150%
        let tier_multiplier: u64 = match referrer_profile.tier {
            3 => 150,
            2 => 125,
            _ => 100,
        };

        let effective_referrer_bps = ((campaign.referrer_bps as u64)
            .checked_mul(tier_multiplier)
            .ok_or(ReferralError::MathOverflow)?
            / 100) as u64;

        let referrer_reward = deposit_amount
            .checked_mul(effective_referrer_bps)
            .ok_or(ReferralError::MathOverflow)?
            / 10_000;

        let referee_rebate = deposit_amount
            .checked_mul(campaign.referee_rebate_bps as u64)
            .ok_or(ReferralError::MathOverflow)?
            / 10_000;

        let campaign_name = campaign.campaign_name.clone();
        let campaign_seeds = &[
            b"campaign".as_ref(),
            campaign_name.as_bytes(),
            &[campaign.bump],
        ];
        let signer_seeds = &[&campaign_seeds[..]];

        // 3. Disburse Referrer Reward from Vault PDA
        if referrer_reward > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.referrer_token_account.to_account_info(),
                        authority: ctx.accounts.campaign.to_account_info(),
                    },
                    signer_seeds,
                ),
                referrer_reward,
            )?;
        }

        // 4. Disburse Referee Welcome Rebate from Vault PDA
        if referee_rebate > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.referee_token_account.to_account_info(),
                        authority: ctx.accounts.campaign.to_account_info(),
                    },
                    signer_seeds,
                ),
                referee_rebate,
            )?;
        }

        // 5. Update Persistent States
        referral_record.has_completed_qualifying_action = true;
        referrer_profile.total_rewards_earned = referrer_profile
            .total_rewards_earned
            .checked_add(referrer_reward)
            .ok_or(ReferralError::MathOverflow)?;

        campaign.total_volume = campaign
            .total_volume
            .checked_add(deposit_amount)
            .ok_or(ReferralError::MathOverflow)?;
        campaign.total_referrals = campaign
            .total_referrals
            .checked_add(1)
            .ok_or(ReferralError::MathOverflow)?;

        emit!(QualifyingActionExecutedEvent {
            campaign: campaign.key(),
            referrer: ctx.accounts.referrer.key(),
            referee: ctx.accounts.referee.key(),
            deposit_amount,
            referrer_reward,
            referee_rebate,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(campaign_name: String)]
pub struct InitializeCampaign<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Campaign::INIT_SPACE,
        seeds = [b"campaign", campaign_name.as_bytes()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [b"vault", campaign.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = campaign,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RegisterReferrer<'info> {
    #[account(
        init,
        payer = referrer,
        space = 8 + ReferrerProfile::INIT_SPACE,
        seeds = [b"referrer", campaign.key().as_ref(), referrer.key().as_ref()],
        bump
    )]
    pub referrer_profile: Account<'info, ReferrerProfile>,

    pub campaign: Account<'info, Campaign>,

    #[account(mut)]
    pub referrer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptReferral<'info> {
    #[account(
        init,
        payer = referee,
        space = 8 + ReferralRecord::INIT_SPACE,
        seeds = [b"referral", campaign.key().as_ref(), referee.key().as_ref()],
        bump
    )]
    pub referral_record: Account<'info, ReferralRecord>,

    #[account(
        mut,
        seeds = [b"referrer", campaign.key().as_ref(), referrer.key().as_ref()],
        bump = referrer_profile.bump,
        has_one = referrer,
        has_one = campaign,
    )]
    pub referrer_profile: Account<'info, ReferrerProfile>,

    /// CHECK: Validated via profile account constraint
    pub referrer: AccountInfo<'info>,

    pub campaign: Account<'info, Campaign>,

    #[account(mut)]
    pub referee: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteQualifyingAction<'info> {
    #[account(
        mut,
        seeds = [b"campaign", campaign.campaign_name.as_bytes()],
        bump = campaign.bump,
        has_one = vault,
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [b"referral", campaign.key().as_ref(), referee.key().as_ref()],
        bump = referral_record.bump,
        has_one = campaign,
        has_one = referrer,
        has_one = referee,
    )]
    pub referral_record: Account<'info, ReferralRecord>,

    #[account(
        mut,
        seeds = [b"referrer", campaign.key().as_ref(), referrer.key().as_ref()],
        bump = referrer_profile.bump,
        has_one = referrer,
        has_one = campaign,
    )]
    pub referrer_profile: Account<'info, ReferrerProfile>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub referee_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub referrer_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub referee: Signer<'info>,

    /// CHECK: Public key checked against referral record & profile
    pub referrer: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE SCHEMAS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Campaign {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    #[max_len(32)]
    pub campaign_name: String,
    pub referrer_bps: u16,
    pub referee_rebate_bps: u16,
    pub min_qualifying_deposit: u64,
    pub total_referrals: u64,
    pub total_volume: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ReferrerProfile {
    pub campaign: Pubkey,
    pub referrer: Pubkey,
    pub total_referred_users: u64,
    pub total_rewards_earned: u64,
    pub tier: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ReferralRecord {
    pub campaign: Pubkey,
    pub referrer: Pubkey,
    pub referee: Pubkey,
    pub has_completed_qualifying_action: bool,
    pub joined_at: i64,
    pub bump: u8,
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct CampaignInitializedEvent {
    pub campaign: Pubkey,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub referrer_bps: u16,
    pub referee_rebate_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct ReferrerRegisteredEvent {
    pub campaign: Pubkey,
    pub referrer: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ReferralAcceptedEvent {
    pub campaign: Pubkey,
    pub referrer: Pubkey,
    pub referee: Pubkey,
    pub current_tier: u8,
    pub timestamp: i64,
}

#[event]
pub struct QualifyingActionExecutedEvent {
    pub campaign: Pubkey,
    pub referrer: Pubkey,
    pub referee: Pubkey,
    pub deposit_amount: u64,
    pub referrer_reward: u64,
    pub referee_rebate: u64,
    pub timestamp: i64,
}

#[error_code]
pub enum ReferralError {
    #[msg("Campaign name exceeds 32 characters")]
    NameTooLong,
    #[msg("Aggregate BPS must be equal to or less than 10,000")]
    InvalidBpsAllocation,
    #[msg("Self-referral is strictly forbidden")]
    SelfReferralNotPermitted,
    #[msg("Mathematical overflow occurred during reward calculation")]
    MathOverflow,
    #[msg("Deposit amount is strictly below the minimum qualifying criteria")]
    DepositBelowThreshold,
    #[msg("Qualifying referral reward has already been executed for this account")]
    ActionAlreadyCompleted,
}