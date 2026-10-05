use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    ed25519_program,
    instruction::Instruction,
    program::invoke,
    system_instruction,
};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("SegmXz6T257qJp6q8d9M14VqFm3k8KqF4N3d9T8wXyz");

pub const CAMPAIGN_SEED: &[u8] = b"campaign";
pub const REFERRER_SEED: &[u8] = b"referrer";
pub const REFERRAL_LINK_SEED: &[u8] = b"referral_link";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod segmento_referrals {
    use super::*;

    /// Initialize a new referral campaign for a Segmento audience cohort
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        campaign_id: String,
        base_reward: u64,
        tier1_threshold: u32,
        tier1_multiplier_bps: u16,
        tier2_threshold: u32,
        tier2_multiplier_bps: u16,
        oracle_pubkey: Pubkey,
    ) -> Result<()> {
        require!(campaign_id.len() <= 32, ReferralsError::CampaignIdTooLong);
        require!(base_reward > 0, ReferralsError::InvalidRewardAmount);
        require!(tier1_threshold < tier2_threshold, ReferralsError::InvalidTierConfiguration);
        require!(tier1_multiplier_bps >= 10000, ReferralsError::InvalidMultiplier);
        require!(tier2_multiplier_bps >= tier1_multiplier_bps, ReferralsError::InvalidMultiplier);

        let campaign = &mut ctx.accounts.campaign;
        campaign.authority = ctx.accounts.authority.key();
        campaign.oracle_pubkey = oracle_pubkey;
        campaign.campaign_id = campaign_id;
        campaign.base_reward = base_reward;
        campaign.tier1_threshold = tier1_threshold;
        campaign.tier1_multiplier_bps = tier1_multiplier_bps;
        campaign.tier2_threshold = tier2_threshold;
        campaign.tier2_multiplier_bps = tier2_multiplier_bps;
        campaign.reward_mint = ctx.accounts.reward_mint.key();
        campaign.total_referrals_processed = 0;
        campaign.total_rewards_disbursed = 0;
        campaign.is_active = true;
        campaign.bump = ctx.bumps.campaign;
        campaign.vault_bump = ctx.bumps.reward_vault;

        emit!(CampaignInitializedEvent {
            campaign_id: campaign.campaign_id.clone(),
            authority: campaign.authority,
            base_reward,
            oracle_pubkey,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Deposit rewards into the campaign escrow vault
    pub fn fund_campaign_vault(ctx: Context<FundCampaignVault>, amount: u64) -> Result<()> {
        require!(amount > 0, ReferralsError::ZeroDeposit);

        let cpi_accounts = Transfer {
            from: ctx.accounts.funder_token_account.to_account_info(),
            to: ctx.accounts.reward_vault.to_account_info(),
            authority: ctx.accounts.funder.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(CampaignFundedEvent {
            campaign_id: ctx.accounts.campaign.campaign_id.clone(),
            funder: ctx.accounts.funder.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Register a referrer for a specific campaign
    pub fn register_referrer(ctx: Context<RegisterReferrer>) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        require!(campaign.is_active, ReferralsError::CampaignInactive);

        let referrer_profile = &mut ctx.accounts.referrer_profile;
        referrer_profile.campaign = campaign.key();
        referrer_profile.referrer = ctx.accounts.referrer.key();
        referrer_profile.referral_count = 0;
        referrer_profile.total_earned = 0;
        referrer_profile.tier = ReferrerTier::Base;
        referrer_profile.bump = ctx.bumps.referrer_profile;

        emit!(ReferrerRegisteredEvent {
            campaign_id: campaign.campaign_id.clone(),
            referrer: referrer_profile.referrer,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Claim a referral link backed by Segmento Oracle validation
    /// Bob brings Alice's link and presents an oracle-signed authorization
    pub fn claim_referral(
        ctx: Context<ClaimReferral>,
        sig_data: [u8; 64],
        msg_hash: [u8; 32],
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        require!(campaign.is_active, ReferralsError::CampaignInactive);

        let referrer_key = ctx.accounts.referrer.key();
        let referred_key = ctx.accounts.referred_user.key();

        // Sybil Defense: Cannot refer self
        require!(referrer_key != referred_key, ReferralsError::SelfReferralProhibited);

        // Verify ed25519 signature from Segmento Oracle:
        // Message format = hash(campaign_id + referrer_pubkey + referred_pubkey)
        let mut expected_message_payload = Vec::new();
        expected_message_payload.extend_from_slice(campaign.campaign_id.as_bytes());
        expected_message_payload.extend_from_slice(referrer_key.as_ref());
        expected_message_payload.extend_from_slice(referred_key.as_ref());
        let computed_hash = anchor_lang::solana_program::hash::hash(&expected_message_payload).to_bytes();
        
        require!(computed_hash == msg_hash, ReferralsError::InvalidOracleMessage);

        // Process instruction sysvar for ed25519 program verification
        let ix_sysvar = &ctx.accounts.instructions_sysvar;
        verify_ed25519_instruction(
            ix_sysvar,
            &campaign.oracle_pubkey.to_bytes(),
            &computed_hash,
            &sig_data,
        )?;

        // Record Referral Link to guarantee uniqueness and prevent replay
        let referral_link = &mut ctx.accounts.referral_link;
        referral_link.campaign = campaign.key();
        referral_link.referrer = referrer_key;
        referral_link.referred_user = referred_key;
        referral_link.created_at = Clock::get()?.unix_timestamp;
        referral_link.bump = ctx.bumps.referral_link;

        // Calculate tiered reward
        let referrer_profile = &mut ctx.accounts.referrer_profile;
        let new_referral_count = referrer_profile.referral_count.checked_add(1)
            .ok_or(ReferralsError::ArithmeticOverflow)?;
        referrer_profile.referral_count = new_referral_count;

        let multiplier_bps: u64 = if new_referral_count >= campaign.tier2_threshold {
            referrer_profile.tier = ReferrerTier::Tier2;
            campaign.tier2_multiplier_bps as u64
        } else if new_referral_count >= campaign.tier1_threshold {
            referrer_profile.tier = ReferrerTier::Tier1;
            campaign.tier1_multiplier_bps as u64
        } else {
            referrer_profile.tier = ReferrerTier::Base;
            10000 // 1.0x Base
        };

        let calculated_payout = (campaign.base_reward as u128)
            .checked_mul(multiplier_bps as u128)
            .ok_or(ReferralsError::ArithmeticOverflow)?
            .checked_div(10000)
            .ok_or(ReferralsError::ArithmeticOverflow)? as u64;

        require!(
            ctx.accounts.reward_vault.amount >= calculated_payout,
            ReferralsError::InsufficientVaultLiquidity
        );

        // Execute CPI transfer from PDA Vault to Referrer token account
        let campaign_id_bytes = campaign.campaign_id.as_bytes();
        let seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED,
            campaign_id_bytes,
            &[campaign.vault_bump],
        ]];

        let transfer_accounts = Transfer {
            from: ctx.accounts.reward_vault.to_account_info(),
            to: ctx.accounts.referrer_token_account.to_account_info(),
            authority: ctx.accounts.reward_vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
            seeds,
        );
        token::transfer(cpi_ctx, calculated_payout)?;

        referrer_profile.total_earned = referrer_profile
            .total_earned
            .checked_add(calculated_payout)
            .ok_or(ReferralsError::ArithmeticOverflow)?;

        campaign.total_referrals_processed = campaign
            .total_referrals_processed
            .checked_add(1)
            .ok_or(ReferralsError::ArithmeticOverflow)?;

        campaign.total_rewards_disbursed = campaign
            .total_rewards_disbursed
            .checked_add(calculated_payout)
            .ok_or(ReferralsError::ArithmeticOverflow)?;

        emit!(ReferralRedeemedEvent {
            campaign_id: campaign.campaign_id.clone(),
            referrer: referrer_key,
            referred_user: referred_key,
            payout: calculated_payout,
            new_tier: referrer_profile.tier.clone(),
            referral_total: new_referral_count,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Toggle campaign active state
    pub fn set_campaign_state(ctx: Context<SetCampaignState>, is_active: bool) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        require!(campaign.authority == ctx.accounts.authority.key(), ReferralsError::Unauthorized);
        campaign.is_active = is_active;
        Ok(())
    }
}

// -----------------------------------------------------------------------------
// VERIFICATION HELPER (Ed25519 Program Signature Verification)
// -----------------------------------------------------------------------------

fn verify_ed25519_instruction(
    ix_sysvar: &AccountInfo,
    expected_pubkey: &[u8; 32],
    expected_message: &[u8; 32],
    expected_sig: &[u8; 64],
) -> Result<()> {
    // Instruction introspection for Ed25519 program verification
    let current_index = anchor_lang::solana_program::sysvar::instructions::load_current_index_checked(ix_sysvar)?;
    if current_index == 0 {
        return err!(ReferralsError::MissingPrecedingVerificationInstruction);
    }

    let prior_ix = anchor_lang::solana_program::sysvar::instructions::load_instruction_at_checked(
        (current_index - 1) as usize,
        ix_sysvar,
    )?;

    // Ensure the prior instruction was strictly targeting the Ed25519 signature verify native program
    require!(
        prior_ix.program_id == ed25519_program::id(),
        ReferralsError::InvalidVerificationProgram
    );

    // Ed25519 native ix layout check:
    // Offset 16..48: Pubkey, Offset 48..112: Signature, Offset 112..144: Message data
    let data = &prior_ix.data;
    require!(data.len() >= 112, ReferralsError::MalformedEd25519Instruction);

    // Validate public key offset match
    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let pubkey = &data[pubkey_offset..pubkey_offset + 32];
    require!(pubkey == expected_pubkey, ReferralsError::SignatureKeyMismatch);

    // Validate signature match
    let sig_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let sig = &data[sig_offset..sig_offset + 64];
    require!(sig == expected_sig, ReferralsError::SignatureDataMismatch);

    // Validate message payload match
    let msg_offset = u16::from_le_bytes([data[2], data[3]]) as usize;
    let msg_size = u16::from_le_bytes([data[4], data[5]]) as usize;
    let msg = &data[msg_offset..msg_offset + msg_size];
    require!(msg == expected_message, ReferralsError::MessageHashMismatch);

    Ok(())
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(campaign_id: String)]
pub struct InitializeCampaign<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Campaign::LEN,
        seeds = [CAMPAIGN_SEED, campaign_id.as_bytes()],
        bump
    )]
    pub campaign: Box<Account<'info, Campaign>>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, campaign_id.as_bytes()],
        bump,
        token::mint = reward_mint,
        token::authority = reward_vault,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundCampaignVault<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [VAULT_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.vault_bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = funder_token_account.mint == campaign.reward_mint @ ReferralsError::MintMismatch,
        constraint = funder_token_account.owner == funder.key() @ ReferralsError::Unauthorized
    )]
    pub funder_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RegisterReferrer<'info> {
    #[account(mut)]
    pub referrer: Signer<'info>,

    #[account(
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        init,
        payer = referrer,
        space = ReferrerProfile::LEN,
        seeds = [REFERRER_SEED, campaign.campaign_id.as_bytes(), referrer.key().as_ref()],
        bump
    )]
    pub referrer_profile: Account<'info, ReferrerProfile>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimReferral<'info> {
    #[account(mut)]
    pub referred_user: Signer<'info>,

    /// CHECK: Validated via seeds check against ReferrerProfile
    pub referrer: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Box<Account<'info, Campaign>>,

    #[account(
        mut,
        seeds = [REFERRER_SEED, campaign.campaign_id.as_bytes(), referrer.key().as_ref()],
        bump = referrer_profile.bump,
        constraint = referrer_profile.referrer == referrer.key() @ ReferralsError::InvalidReferrer
    )]
    pub referrer_profile: Box<Account<'info, ReferrerProfile>>,

    #[account(
        init,
        payer = referred_user,
        space = ReferralLink::LEN,
        seeds = [REFERRAL_LINK_SEED, campaign.campaign_id.as_bytes(), referred_user.key().as_ref()],
        bump
    )]
    pub referral_link: Box<Account<'info, ReferralLink>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.vault_bump
    )]
    pub reward_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = referrer_token_account.owner == referrer.key() @ ReferralsError::InvalidTokenOwner,
        constraint = referrer_token_account.mint == campaign.reward_mint @ ReferralsError::MintMismatch
    )]
    pub referrer_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: Instructions Sysvar account for ed25519 verification
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetCampaignState<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.bump,
        has_one = authority @ ReferralsError::Unauthorized
    )]
    pub campaign: Account<'info, Campaign>,
}

// -----------------------------------------------------------------------------
// DATA STATE STRUCTURES
// -----------------------------------------------------------------------------

#[account]
pub struct Campaign {
    pub authority: Pubkey,
    pub oracle_pubkey: Pubkey,
    pub reward_mint: Pubkey,
    pub campaign_id: String,
    pub base_reward: u64,
    pub tier1_threshold: u32,
    pub tier1_multiplier_bps: u16,
    pub tier2_threshold: u32,
    pub tier2_multiplier_bps: u16,
    pub total_referrals_processed: u64,
    pub total_rewards_disbursed: u64,
    pub is_active: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Campaign {
    pub const LEN: usize = 8 + // discriminator
        32 + // authority
        32 + // oracle_pubkey
        32 + // reward_mint
        (4 + 32) + // campaign_id
        8 + // base_reward
        4 + // tier1_threshold
        2 + // tier1_multiplier_bps
        4 + // tier2_threshold
        2 + // tier2_multiplier_bps
        8 + // total_referrals_processed
        8 + // total_rewards_disbursed
        1 + // is_active
        1 + // bump
        1; // vault_bump
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum ReferrerTier {
    Base,
    Tier1,
    Tier2,
}

#[account]
pub struct ReferrerProfile {
    pub campaign: Pubkey,
    pub referrer: Pubkey,
    pub referral_count: u32,
    pub total_earned: u64,
    pub tier: ReferrerTier,
    pub bump: u8,
}

impl ReferrerProfile {
    pub const LEN: usize = 8 + // discriminator
        32 + // campaign
        32 + // referrer
        4 +  // referral_count
        8 +  // total_earned
        1 +  // tier enum
        1;   // bump
}

#[account]
pub struct ReferralLink {
    pub campaign: Pubkey,
    pub referrer: Pubkey,
    pub referred_user: Pubkey,
    pub created_at: i64,
    pub bump: u8,
}

impl ReferralLink {
    pub const LEN: usize = 8 + // discriminator
        32 + // campaign
        32 + // referrer
        32 + // referred_user
        8 +  // created_at
        1;   // bump
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct CampaignInitializedEvent {
    pub campaign_id: String,
    pub authority: Pubkey,
    pub base_reward: u64,
    pub oracle_pubkey: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct CampaignFundedEvent {
    pub campaign_id: String,
    pub funder: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct ReferrerRegisteredEvent {
    pub campaign_id: String,
    pub referrer: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct ReferralRedeemedEvent {
    pub campaign_id: String,
    pub referrer: Pubkey,
    pub referred_user: Pubkey,
    pub payout: u64,
    pub new_tier: ReferrerTier,
    pub referral_total: u32,
    pub timestamp: i64,
}

#[error_code]
pub enum ReferralsError {
    #[msg("Campaign ID exceeds max string length of 32 bytes.")]
    CampaignIdTooLong,
    #[msg("Base reward must be greater than zero.")]
    InvalidRewardAmount,
    #[msg("Tier 1 threshold must be strictly less than Tier 2 threshold.")]
    InvalidTierConfiguration,
    #[msg("Tier multiplier must be >= 10000 (1.0x).")]
    InvalidMultiplier,
    #[msg("Campaign is currently inactive.")]
    CampaignInactive,
    #[msg("Deposit amount must be strictly greater than zero.")]
    ZeroDeposit,
    #[msg("Self-referral is cryptographically prohibited.")]
    SelfReferralProhibited,
    #[msg("Provided message hash does not match computed verification payload.")]
    InvalidOracleMessage,
    #[msg("Missing required prior Ed25519 verification instruction.")]
    MissingPrecedingVerificationInstruction,
    #[msg("Prior instruction is not a valid Ed25519 signature verification program.")]
    InvalidVerificationProgram,
    #[msg("Ed25519 verification instruction is malformed.")]
    MalformedEd25519Instruction,
    #[msg("Oracle public key in Ed25519 instruction does not match campaign authority.")]
    SignatureKeyMismatch,
    #[msg("Signature data does not match provided payload.")]
    SignatureDataMismatch,
    #[msg("Message payload in Ed25519 ix does not match hash.")]
    MessageHashMismatch,
    #[msg("Referrer profile does not match passed referrer account.")]
    InvalidReferrer,
    #[msg("Referrer token account owner mismatch.")]
    InvalidTokenOwner,
    #[msg("Token account mint mismatch.")]
    MintMismatch,
    #[msg("Arithmetic overflow in calculation.")]
    ArithmeticOverflow,
    #[msg("Reward vault does not have sufficient liquidity for referral payout.")]
    InsufficientVaultLiquidity,
    #[msg("Unauthorized invocation.")]
    Unauthorized,
}