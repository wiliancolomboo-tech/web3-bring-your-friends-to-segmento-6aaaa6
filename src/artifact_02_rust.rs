use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("SegmRefer11111111111111111111111111111111111");

pub const MAX_CAMPAIGN_NAME_LEN: usize = 32;
pub const BASIS_POINTS_DIVISOR: u16 = 10_000;

#[program]
pub mod segmento_referrals {
    use super::*;

    /// Initialize a master referrer profile.
    pub fn initialize_referrer(
        ctx: Context<InitializeReferrer>,
        metadata_uri: String,
    ) -> Result<()> {
        require!(metadata_uri.len() <= 128, ReferralError::StringTooLong);
        let referrer = &mut ctx.accounts.referrer_profile;
        referrer.authority = ctx.accounts.authority.key();
        referrer.total_referrals = 0;
        referrer.total_rewards_earned = 0;
        referrer.metadata_uri = metadata_uri;
        referrer.bump = ctx.bumps.referrer_profile;

        emit!(ReferrerRegisteredEvent {
            referrer: ctx.accounts.authority.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Create a customized campaign with specified reward pools and kickback percentages.
    pub fn create_campaign(
        ctx: Context<CreateCampaign>,
        campaign_id: u64,
        name: String,
        reward_per_activation: u64,
        referee_kickback_bps: u16,
    ) -> Result<()> {
        require!(name.len() <= MAX_CAMPAIGN_NAME_LEN, ReferralError::StringTooLong);
        require!(referee_kickback_bps <= BASIS_POINTS_DIVISOR, ReferralError::InvalidBasisPoints);
        require!(reward_per_activation > 0, ReferralError::InvalidRewardAmount);

        let campaign = &mut ctx.accounts.campaign;
        campaign.authority = ctx.accounts.authority.key();
        campaign.campaign_id = campaign_id;
        campaign.name = name;
        campaign.reward_per_activation = reward_per_activation;
        campaign.referee_kickback_bps = referee_kickback_bps;
        campaign.total_activations = 0;
        campaign.is_active = true;
        campaign.bump = ctx.bumps.campaign;
        campaign.escrow_bump = ctx.bumps.escrow_vault;

        emit!(CampaignCreatedEvent {
            campaign_id,
            authority: ctx.accounts.authority.key(),
            reward_per_activation,
            referee_kickback_bps,
        });

        Ok(())
    }

    /// Deposit funds into the campaign escrow vault to fund referral rewards.
    pub fn fund_campaign_escrow(ctx: Context<FundCampaignEscrow>, amount: u64) -> Result<()> {
        require!(amount > 0, ReferralError::InvalidRewardAmount);

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: ctx.accounts.escrow_vault.to_account_info(),
            },
        );
        transfer(cpi_context, amount)?;

        emit!(EscrowFundedEvent {
            campaign: ctx.accounts.campaign.key(),
            funder: ctx.accounts.funder.key(),
            amount,
        });

        Ok(())
    }

    /// Link a referee to a specific referrer campaign.
    pub fn link_referee(ctx: Context<LinkReferee>) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        require!(campaign.is_active, ReferralError::CampaignInactive);
        require!(
            ctx.accounts.referee.key() != ctx.accounts.referrer_profile.authority,
            ReferralError::SelfReferralNotAllowed
        );

        let link = &mut ctx.accounts.referral_link;
        link.campaign = campaign.key();
        link.referrer = ctx.accounts.referrer_profile.key();
        link.referee = ctx.accounts.referee.key();
        link.is_activated = false;
        link.created_at = Clock::get()?.unix_timestamp;
        link.bump = ctx.bumps.referral_link;

        let referrer = &mut ctx.accounts.referrer_profile;
        referrer.total_referrals = referrer.total_referrals.checked_add(1).ok_or(ReferralError::MathOverflow)?;

        emit!(RefereeLinkedEvent {
            campaign: campaign.key(),
            referrer: referrer.authority,
            referee: ctx.accounts.referee.key(),
            timestamp: link.created_at,
        });

        Ok(())
    }

    /// Verify an activation milestone and atomically payout split incentives.
    pub fn trigger_activation(ctx: Context<TriggerActivation>) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        require!(campaign.is_active, ReferralError::CampaignInactive);

        let link = &mut ctx.accounts.referral_link;
        require!(!link.is_activated, ReferralError::AlreadyActivated);

        let reward = campaign.reward_per_activation;
        let escrow_balance = ctx.accounts.escrow_vault.to_account_info().lamports();
        require!(escrow_balance >= reward, ReferralError::InsufficientEscrowBalance);

        // Calculate kickback splits
        let referee_share = (reward as u128)
            .checked_mul(campaign.referee_kickback_bps as u128)
            .ok_or(ReferralError::MathOverflow)?
            .checked_div(BASIS_POINTS_DIVISOR as u128)
            .ok_or(ReferralError::MathOverflow)? as u64;

        let referrer_share = reward
            .checked_sub(referee_share)
            .ok_or(ReferralError::MathOverflow)?;

        // Execute escrow transfers via PDA signer
        let campaign_key = campaign.key();
        let escrow_seeds: &[&[u8]] = &[
            b"escrow",
            campaign_key.as_ref(),
            &[campaign.escrow_bump],
        ];
        let signer = &[&escrow_seeds[..]];

        if referee_share > 0 {
            let cpi_referee = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.referee.to_account_info(),
                },
                signer,
            );
            transfer(cpi_referee, referee_share)?;
        }

        if referrer_share > 0 {
            let cpi_referrer = CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_vault.to_account_info(),
                    to: ctx.accounts.referrer_authority.to_account_info(),
                },
                signer,
            );
            transfer(cpi_referrer, referrer_share)?;
        }

        // Update state
        link.is_activated = true;
        campaign.total_activations = campaign
            .total_activations
            .checked_add(1)
            .ok_or(ReferralError::MathOverflow)?;

        let referrer = &mut ctx.accounts.referrer_profile;
        referrer.total_rewards_earned = referrer
            .total_rewards_earned
            .checked_add(referrer_share)
            .ok_or(ReferralError::MathOverflow)?;

        emit!(ReferralActivatedEvent {
            campaign: campaign.key(),
            referrer: referrer.authority,
            referee: ctx.accounts.referee.key(),
            referrer_reward: referrer_share,
            referee_reward: referee_share,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(metadata_uri: String)]
pub struct InitializeReferrer<'info> {
    #[account(
        init,
        payer = authority,
        space = ReferrerProfile::LEN,
        seeds = [b"referrer", authority.key().as_ref()],
        bump
    )]
    pub referrer_profile: Account<'info, ReferrerProfile>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct CreateCampaign<'info> {
    #[account(
        init,
        payer = authority,
        space = CampaignConfig::LEN,
        seeds = [b"campaign", authority.key().as_ref(), &campaign_id.to_le_bytes()],
        bump
    )]
    pub campaign: Account<'info, CampaignConfig>,
    #[account(
        mut,
        seeds = [b"escrow", campaign.key().as_ref()],
        bump
    )]
    pub escrow_vault: SystemAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub mod fund_escrow {
    use super::*;

    #[derive(Accounts)]
    pub struct FundCampaignEscrow<'info> {
        #[account(mut)]
        pub campaign: Account<'info, CampaignConfig>,
        #[account(
            mut,
            seeds = [b"escrow", campaign.key().as_ref()],
            bump = campaign.escrow_bump
        )]
        pub escrow_vault: SystemAccount<'info>,
        #[account(mut)]
        pub funder: Signer<'info>,
        pub system_program: Program<'info, System>,
    }
}
pub use fund_escrow::*;

#[derive(Accounts)]
pub struct LinkReferee<'info> {
    #[account(
        init,
        payer = referee,
        space = ReferralLinkAccount::LEN,
        seeds = [b"referral-link", campaign.key().as_ref(), referee.key().as_ref()],
        bump
    )]
    pub referral_link: Account<'info, ReferralLinkAccount>,
    #[account(mut)]
    pub campaign: Account<'info, CampaignConfig>,
    #[account(mut)]
    pub referrer_profile: Account<'info, ReferrerProfile>,
    #[account(mut)]
    pub referee: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TriggerActivation<'info> {
    #[account(
        mut,
        has_one = escrow_vault,
    )]
    pub campaign: Account<'info, CampaignConfig>,
    #[account(
        mut,
        seeds = [b"escrow", campaign.key().as_ref()],
        bump = campaign.escrow_bump
    )]
    pub escrow_vault: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [b"referral-link", campaign.key().as_ref(), referee.key().as_ref()],
        bump = referral_link.bump,
        has_one = campaign,
        has_one = referee
    )]
    pub referral_link: Account<'info, ReferralLinkAccount>,
    #[account(
        mut,
        has_one = authority @ ReferralError::UnauthorizedReferrerAuthority
    )]
    pub referrer_profile: Account<'info, ReferrerProfile>,
    /// CHECK: Validated against referrer_profile.authority
    #[account(mut, address = referrer_profile.authority)]
    pub referrer_authority: AccountInfo<'info>,
    /// CHECK: Validated against referral_link.referee
    #[account(mut, address = referral_link.referee)]
    pub referee: AccountInfo<'info>,
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// STATE DATA STRUCTURES
// -----------------------------------------------------------------------------

#[account]
pub struct ReferrerProfile {
    pub authority: Pubkey,         // 32
    pub total_referrals: u64,      // 8
    pub total_rewards_earned: u64, // 8
    pub metadata_uri: String,      // 4 + 128
    pub bump: u8,                  // 1
}

impl ReferrerProfile {
    pub const LEN: usize = 8 + 32 + 8 + 8 + (4 + 128) + 1;
}

#[account]
pub struct CampaignConfig {
    pub authority: Pubkey,             // 32
    pub campaign_id: u64,              // 8
    pub name: String,                  // 4 + 32
    pub reward_per_activation: u64,    // 8
    pub referee_kickback_bps: u16,     // 2
    pub total_activations: u64,        // 8
    pub is_active: bool,               // 1
    pub bump: u8,                      // 1
    pub escrow_bump: u8,               // 1
}

impl CampaignConfig {
    pub const LEN: usize = 8 + 32 + 8 + (4 + 32) + 8 + 2 + 8 + 1 + 1 + 1;
}

#[account]
pub struct ReferralLinkAccount {
    pub campaign: Pubkey,   // 32
    pub referrer: Pubkey,   // 32
    pub referee: Pubkey,    // 32
    pub is_activated: bool, // 1
    pub created_at: i64,    // 8
    pub bump: u8,           // 1
}

impl ReferralLinkAccount {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 1 + 8 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct ReferrerRegisteredEvent {
    pub referrer: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct CampaignCreatedEvent {
    pub campaign_id: u64,
    pub authority: Pubkey,
    pub reward_per_activation: u64,
    pub referee_kickback_bps: u16,
}

#[event]
pub struct EscrowFundedEvent {
    pub campaign: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
}

#[event]
pub struct RefereeLinkedEvent {
    pub campaign: Pubkey,
    pub referrer: Pubkey,
    pub referee: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ReferralActivatedEvent {
    pub campaign: Pubkey,
    pub referrer: Pubkey,
    pub referee: Pubkey,
    pub referrer_reward: u64,
    pub referee_reward: u64,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERRORS
// -----------------------------------------------------------------------------

#[error_code]
pub enum ReferralError {
    #[msg("String exceeds maximum permitted length")]
    StringTooLong,
    #[msg("Basis points cannot exceed 10000 (100%)")]
    InvalidBasisPoints,
    #[msg("Reward amount must be greater than zero")]
    InvalidRewardAmount,
    #[msg("The requested campaign is currently inactive")]
    CampaignInactive,
    #[msg("Self-referrals are strictly prohibited")]
    SelfReferralNotAllowed,
    #[msg("The referral reward has already been activated")]
    AlreadyActivated,
    #[msg("The campaign escrow vault does not have sufficient balance")]
    InsufficientEscrowBalance,
    #[msg("Math calculation resulted in an overflow or underflow")]
    MathOverflow,
    #[msg("Referrer authority mismatch")]
    UnauthorizedReferrerAuthority,
}