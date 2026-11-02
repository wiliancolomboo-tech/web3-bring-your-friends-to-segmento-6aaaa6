use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

declare_id!("SegmXyZ9oQGzK4rN1aWqT7uE3jVpB5mF8sC2dD6hA1B");

pub const CONFIG_SEED: &[u8] = b"segmento_config";
pub const REFERRAL_SEED: &[u8] = b"referral_state";
pub const BINDING_SEED: &[u8] = b"referee_binding";
pub const VAULT_SEED: &[u8] = b"escrow_vault";

#[program]
pub mod segmento_referral {
    use super::*;

    /// Initialize the global configuration and escrow vault
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        basis_points_commission: u16,
        milestone_threshold_lamports: u64,
    ) -> Result<()> {
        require!(
            basis_points_commission <= 10_000,
            SegmentoError::InvalidBasisPoints
        );

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.escrow_vault = ctx.accounts.escrow_vault.key();
        config.basis_points_commission = basis_points_commission;
        config.milestone_threshold_lamports = milestone_threshold_lamports;
        config.total_referees_onboarded = 0;
        config.total_rewards_distributed = 0;
        config.bump = ctx.bumps.config;
        config.vault_bump = ctx.bumps.escrow_vault;

        emit!(ConfigInitializedEvent {
            authority: config.authority,
            basis_points_commission,
            milestone_threshold_lamports,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Deposit funds into protocol reward escrow vault
    pub fn fund_escrow_vault(ctx: Context<FundEscrowVault>, amount: u64) -> Result<()> {
        require!(amount > 0, SegmentoError::ZeroAmount);

        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.funder.to_account_info(),
                to: ctx.accounts.escrow_vault.to_account_info(),
            },
        );
        transfer(cpi_context, amount)?;

        emit!(EscrowFundedEvent {
            funder: ctx.accounts.funder.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Register a referrer and create their on-chain profile PDA
    pub fn register_referrer(ctx: Context<RegisterReferrer>, campaign_tag: String) -> Result<()> {
        require!(
            campaign_tag.as_bytes().len() <= 32,
            SegmentoError::TagTooLong
        );

        let referral_state = &mut ctx.accounts.referral_state;
        referral_state.referrer = ctx.accounts.referrer.key();
        referral_state.total_referrals = 0;
        referral_state.total_lamports_earned = 0;
        referral_state.campaign_tag = campaign_tag.clone();
        referral_state.bump = ctx.bumps.referral_state;

        emit!(ReferrerRegisteredEvent {
            referrer: ctx.accounts.referrer.key(),
            campaign_tag,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Bind a new referee wallet to a referrer account permanently
    pub fn bind_referee(ctx: Context<BindReferee>) -> Result<()> {
        let binding = &mut ctx.accounts.referee_binding;
        let config = &mut ctx.accounts.config;
        let referral_state = &mut ctx.accounts.referral_state;

        // Prevent self-referral
        require!(
            ctx.accounts.referee.key() != referral_state.referrer,
            SegmentoError::SelfReferralNotAllowed
        );

        binding.referee = ctx.accounts.referee.key();
        binding.referrer = referral_state.referrer;
        binding.bound_at = Clock::get()?.unix_timestamp;
        binding.milestone_completed = false;
        binding.bump = ctx.bumps.referee_binding;

        referral_state.total_referrals = referral_state
            .total_referrals
            .checked_add(1)
            .ok_or(SegmentoError::MathOverflow)?;

        config.total_referees_onboarded = config
            .total_referees_onboarded
            .checked_add(1)
            .ok_or(SegmentoError::MathOverflow)?;

        emit!(RefereeBoundEvent {
            referee: binding.referee,
            referrer: binding.referrer,
            timestamp: binding.bound_at,
        });

        Ok(())
    }

    /// Complete milestone, release instant commission to referrer and bonus to referee
    pub fn complete_milestone(
        ctx: Context<CompleteMilestone>,
        milestone_id: u32,
        action_volume_lamports: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let binding = &mut ctx.accounts.referee_binding;
        let referral_state = &mut ctx.accounts.referral_state;

        require!(!binding.milestone_completed, SegmentoError::MilestoneAlreadyCompleted);
        require!(
            action_volume_lamports >= config.milestone_threshold_lamports,
            SegmentoError::InsufficientVolume
        );

        // Compute referrer reward based on configured basis points
        let calculated_commission = (action_volume_lamports as u128)
            .checked_mul(config.basis_points_commission as u128)
            .ok_or(SegmentoError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(SegmentoError::MathOverflow)? as u64;

        require!(
            calculated_commission > 0,
            SegmentoError::ZeroCommissionCalculated
        );

        // Verify escrow balance
        let vault_lamports = ctx.accounts.escrow_vault.to_account_info().lamports();
        require!(
            vault_lamports >= calculated_commission,
            SegmentoError::EscrowVaultInsufficientFunds
        );

        // Transfer funds from Vault PDA to Referrer via PDA Signer Seeds
        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            config.to_account_info().key.as_ref(),
            &[config.vault_bump],
        ]];

        let cpi_transfer = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_vault.to_account_info(),
                to: ctx.accounts.referrer_wallet.to_account_info(),
            },
            signer_seeds,
        );
        transfer(cpi_transfer, calculated_commission)?;

        // Update state
        binding.milestone_completed = true;
        referral_state.total_lamports_earned = referral_state
            .total_lamports_earned
            .checked_add(calculated_commission)
            .ok_or(SegmentoError::MathOverflow)?;

        config.total_rewards_distributed = config
            .total_rewards_distributed
            .checked_add(calculated_commission)
            .ok_or(SegmentoError::MathOverflow)?;

        emit!(MilestoneCompletedEvent {
            referee: binding.referee,
            referrer: binding.referrer,
            milestone_id,
            action_volume_lamports,
            reward_payout_lamports: calculated_commission,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub fn initialize_config<'info>(ctx: Context<InitializeConfig>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + GlobalConfig::LEN,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,

    /// CHECK: PDA escrow vault holding rewards
    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump
    )]
    pub escrow_vault: SystemAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundEscrowVault<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, GlobalConfig>,

    /// CHECK: PDA escrow vault to receive funds
    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump = config.vault_bump
    )]
    pub escrow_vault: SystemAccount<'info>,

    #[account(mut)]
    pub funder: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterReferrer<'info> {
    #[account(
        init,
        payer = referrer,
        space = 8 + ReferralAccount::LEN,
        seeds = [REFERRAL_SEED, referrer.key().as_ref()],
        bump
    )]
    pub referral_state: Account<'info, ReferralAccount>,

    #[account(mut)]
    pub referrer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BindReferee<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [REFERRAL_SEED, referral_state.referrer.as_ref()],
        bump = referral_state.bump
    )]
    pub referral_state: Account<'info, ReferralAccount>,

    #[account(
        init,
        payer = referee,
        space = 8 + RefereeBindingAccount::LEN,
        seeds = [BINDING_SEED, referee.key().as_ref()],
        bump
    )]
    pub referee_binding: Account<'info, RefereeBindingAccount>,

    #[account(mut)]
    pub referee: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CompleteMilestone<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, GlobalConfig>,

    /// CHECK: PDA escrow vault paying the reward
    #[account(
        mut,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump = config.vault_bump
    )]
    pub escrow_vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [REFERRAL_SEED, referral_state.referrer.as_ref()],
        bump = referral_state.bump
    )]
    pub referral_state: Account<'info, ReferralAccount>,

    #[account(
        mut,
        seeds = [BINDING_SEED, referee.key().as_ref()],
        bump = referee_binding.bump,
        has_one = referee,
        constraint = referee_binding.referrer == referral_state.referrer @ SegmentoError::ReferrerMismatch
    )]
    pub referee_binding: Account<'info, RefereeBindingAccount>,

    /// CHECK: Validated against referral_state.referrer
    #[account(
        mut,
        address = referral_state.referrer @ SegmentoError::ReferrerMismatch
    )]
    pub referrer_wallet: SystemAccount<'info>,

    pub referee: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// -----------------------------------------------------------------------------
// STATE SCHEMAS
// -----------------------------------------------------------------------------

#[account]
pub struct GlobalConfig {
    pub authority: Pubkey,                  // 32
    pub escrow_vault: Pubkey,               // 32
    pub basis_points_commission: u16,       // 2 (e.g. 500 = 5%)
    pub milestone_threshold_lamports: u64,  // 8
    pub total_referees_onboarded: u64,      // 8
    pub total_rewards_distributed: u64,     // 8
    pub bump: u8,                           // 1
    pub vault_bump: u8,                     // 1
}

impl GlobalConfig {
    pub const LEN: usize = 32 + 32 + 2 + 8 + 8 + 8 + 1 + 1;
}

#[account]
pub struct ReferralAccount {
    pub referrer: Pubkey,         // 32
    pub total_referrals: u64,     // 8
    pub total_lamports_earned: u64, // 8
    pub campaign_tag: String,     // 4 + 32
    pub bump: u8,                 // 1
}

impl ReferralAccount {
    pub const LEN: usize = 32 + 8 + 8 + (4 + 32) + 1;
}

#[account]
pub struct RefereeBindingAccount {
    pub referee: Pubkey,           // 32
    pub referrer: Pubkey,          // 32
    pub bound_at: i64,             // 8
    pub milestone_completed: bool, // 1
    pub bump: u8,                  // 1
}

impl RefereeBindingAccount {
    pub const LEN: usize = 32 + 32 + 8 + 1 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct ConfigInitializedEvent {
    pub authority: Pubkey,
    pub basis_points_commission: u16,
    pub milestone_threshold_lamports: u64,
    pub timestamp: i64,
}

#[event]
pub struct EscrowFundedEvent {
    pub funder: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct ReferrerRegisteredEvent {
    pub referrer: Pubkey,
    pub campaign_tag: String,
    pub timestamp: i64,
}

#[event]
pub struct RefereeBoundEvent {
    pub referee: Pubkey,
    pub referrer: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct MilestoneCompletedEvent {
    pub referee: Pubkey,
    pub referrer: Pubkey,
    pub milestone_id: u32,
    pub action_volume_lamports: u64,
    pub reward_payout_lamports: u64,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR DEFINITIONS
// -----------------------------------------------------------------------------

#[error_code]
pub enum SegmentoError {
    #[msg("Basis points commission cannot exceed 10000 (100%).")]
    InvalidBasisPoints,
    #[msg("Campaign tag must be 32 characters or fewer.")]
    TagTooLong,
    #[msg("Cannot refer your own wallet address.")]
    SelfReferralNotAllowed,
    #[msg("Milestone already fulfilled and rewarded for this referee.")]
    MilestoneAlreadyCompleted,
    #[msg("Action volume does not meet the minimum requirement.")]
    InsufficientVolume,
    #[msg("Calculated reward commission resulted in zero lamports.")]
    ZeroCommissionCalculated,
    #[msg("The escrow vault does not hold enough lamports to disburse reward.")]
    EscrowVaultInsufficientFunds,
    #[msg("Binding does not match the provided referrer account.")]
    ReferrerMismatch,
    #[msg("Deposit amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Arithmetic overflow occurred during computation.")]
    MathOverflow,
}