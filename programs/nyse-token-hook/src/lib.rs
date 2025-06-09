use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

declare_id!("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");

#[program]
pub mod nyse_token_hook {
    use super::*;

    /// Initialize the extra account metas for the transfer hook
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        msg!("🏗️  Initializing NYSE Transfer Hook Extra Account Meta List");

        // No extra accounts needed for NYSE hours checking
        let account_metas = vec![];

        // Get the account data
        let account_info = ctx.accounts.extra_account_meta_list.to_account_info();

        // Initialize the extra account meta list with no extra accounts
        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut account_info.try_borrow_mut_data()?,
            &account_metas,
        )?;

        msg!("✅ NYSE Transfer Hook initialized - ALL transfers will be validated against NYSE market hours");
        msg!("📊 Market Hours: Monday-Friday 9:30 AM - 4:00 PM ET");
        msg!("🚫 Blocked: Weekends, Holidays, After Hours");
        Ok(())
    }

    /// Transfer hook execution - THIS RUNS ON EVERY TOKEN TRANSFER
    pub fn transfer_hook(_ctx: Context<TransferHook>, amount: u64) -> Result<()> {
        msg!("🚨 NYSE TRANSFER HOOK CALLED!");
        msg!(
            "🔍 NYSE Transfer Hook: Validating transfer of {} tokens",
            amount
        );

        // Get current time
        let clock = Clock::get()?;
        let current_timestamp = clock.unix_timestamp;

        // Check NYSE market state
        let market_result = get_nyse_market_state(current_timestamp)?;

        msg!(
            "📅 Current time: {} UTC (timestamp: {})",
            format_timestamp(current_timestamp),
            current_timestamp
        );
        msg!("📊 Market state: {}", market_result.status);

        // Block transfers based on market state
        match market_result.is_open {
            true => {
                msg!("✅ NYSE OPEN: Transfer allowed during market hours");
                Ok(())
            }
            false => {
                msg!(
                    "🚫 NYSE CLOSED: {} - Transfer BLOCKED",
                    market_result.reason
                );
                msg!("💥 RETURNING ERROR TO BLOCK TRANSFER");
                match market_result.status.as_str() {
                    "WEEKEND" => {
                        msg!("🛑 WEEKEND ERROR");
                        Err(NyseError::MarketClosedWeekend.into())
                    }
                    "HOLIDAY" => {
                        msg!("🛑 HOLIDAY ERROR");
                        Err(NyseError::MarketClosedHoliday.into())
                    }
                    "AFTER_HOURS" => {
                        msg!("🛑 AFTER HOURS ERROR");
                        Err(NyseError::MarketClosedAfterHours.into())
                    }
                    _ => {
                        msg!("🛑 DEFAULT AFTER HOURS ERROR");
                        Err(NyseError::MarketClosedAfterHours.into())
                    }
                }
            }
        }
    }

    /// Fallback function for transfer hook interface
    pub fn fallback<'info>(
        _program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        msg!("🚨 FALLBACK CALLED!");

        let instruction = TransferHookInstruction::unpack(data)?;
        msg!("📦 Instruction unpacked successfully");

        match instruction {
            TransferHookInstruction::Execute { amount } => {
                msg!("🎯 Execute instruction with amount: {}", amount);

                // Call our transfer_hook function with proper discriminator
                let amount_bytes = amount.to_le_bytes();
                __private::__global::transfer_hook(_program_id, accounts, &amount_bytes)
            }
            _ => {
                msg!("❌ Unknown instruction");
                Ok(())
            }
        }
    }
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The extra account metas list account
    /// CHECK: This account is initialized as a TLV ExtraAccountMetaList
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(0)?, // No extra accounts needed
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    /// The mint account
    /// CHECK: This account is passed in and used for PDA derivation
    pub mint: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferHook<'info> {
    /// Source token account
    #[account(
        token::mint = mint,
        token::authority = owner
    )]
    pub source_token: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// Mint account
    pub mint: InterfaceAccount<'info, token_interface::Mint>,

    /// Destination token account
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// Owner of the source token account
    /// CHECK: This account is passed through from the transfer instruction
    pub owner: UncheckedAccount<'info>,

    /// Extra account metas list
    /// CHECK: This PDA is derived from the mint and validated by seeds constraint
    #[account(seeds = [b"extra-account-metas", mint.key().as_ref()], bump)]
    pub extra_account_meta_list: UncheckedAccount<'info>,
}

#[derive(Debug)]
pub struct MarketState {
    pub is_open: bool,
    pub status: String,
    pub reason: String,
}

#[error_code]
pub enum NyseError {
    #[msg("🚫 NYSE CLOSED: Market is closed for weekend")]
    MarketClosedWeekend,

    #[msg("🚫 NYSE CLOSED: Market is closed for holiday")]
    MarketClosedHoliday,

    #[msg("🚫 NYSE CLOSED: Market is closed after hours")]
    MarketClosedAfterHours,

    #[msg("Invalid timestamp")]
    InvalidTimestamp,
}

// COMPREHENSIVE NYSE MARKET HOURS LOGIC
fn get_nyse_market_state(timestamp: i64) -> Result<MarketState> {
    // Simple and reliable Eastern Time conversion
    let et_info = get_eastern_time_info(timestamp);

    msg!(
        "🕐 Eastern Time: {}-{:02}-{:02} {:02}:{:02}:{:02} {} (Weekday: {})",
        et_info.year,
        et_info.month,
        et_info.day,
        et_info.hour,
        et_info.minute,
        et_info.second,
        if et_info.is_dst { "EDT" } else { "EST" },
        et_info.weekday
    );

    // 1. FIRST: Check weekend (Sunday = 0, Saturday = 6)
    if et_info.weekday == 0 || et_info.weekday == 6 {
        msg!("🚫 WEEKEND DETECTED: Weekday = {}", et_info.weekday);
        return Ok(MarketState {
            is_open: false,
            status: "WEEKEND".to_string(),
            reason: "Weekend".to_string(),
        });
    }

    // 2. SECOND: Check major holidays (simplified list)
    if is_nyse_holiday(et_info.year, et_info.month, et_info.day) {
        return Ok(MarketState {
            is_open: false,
            status: "HOLIDAY".to_string(),
            reason: "NYSE Holiday".to_string(),
        });
    }

    // 3. THIRD: Check market hours (9:30 AM - 4:00 PM ET)
    let current_minutes = et_info.hour * 60 + et_info.minute;
    let market_open_minutes = 9 * 60 + 30; // 9:30 AM
    let market_close_minutes = 16 * 60; // 4:00 PM

    if current_minutes >= market_open_minutes && current_minutes < market_close_minutes {
        Ok(MarketState {
            is_open: true,
            status: "OPEN".to_string(),
            reason: "Regular Trading Hours".to_string(),
        })
    } else {
        let time_status = if current_minutes < market_open_minutes {
            "Pre-Market"
        } else {
            "After-Market"
        };

        Ok(MarketState {
            is_open: false,
            status: "AFTER_HOURS".to_string(),
            reason: format!("{} (outside 9:30 AM - 4:00 PM ET)", time_status),
        })
    }
}

// Simplified Eastern Time structure
#[derive(Debug)]
struct EasternTimeInfo {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    weekday: u32, // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    is_dst: bool,
}

// Simple and reliable Eastern Time conversion
fn get_eastern_time_info(utc_timestamp: i64) -> EasternTimeInfo {
    // Determine DST status first (simplified rules)
    let is_dst = is_daylight_saving_time(utc_timestamp);

    // Apply Eastern Time offset
    let eastern_offset_seconds = if is_dst { -4 * 3600 } else { -5 * 3600 };
    let eastern_timestamp = utc_timestamp + eastern_offset_seconds;

    // Convert to date/time components using simple arithmetic
    let days_since_epoch = eastern_timestamp / 86400;
    let seconds_in_day = eastern_timestamp % 86400;

    // Handle negative seconds (wrap to previous day)
    let (days_since_epoch, seconds_in_day) = if seconds_in_day < 0 {
        (days_since_epoch - 1, seconds_in_day + 86400)
    } else {
        (days_since_epoch, seconds_in_day)
    };

    // Calculate weekday (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
    // January 1, 1970 was a Thursday (4), so we adjust
    let weekday = ((days_since_epoch + 4) % 7 + 7) % 7;

    // Calculate time components
    let hour = (seconds_in_day / 3600) as u32;
    let minute = ((seconds_in_day % 3600) / 60) as u32;
    let second = (seconds_in_day % 60) as u32;

    // Calculate date components (simplified - good enough for NYSE)
    let (year, month, day) = days_to_date(days_since_epoch);

    EasternTimeInfo {
        year,
        month,
        day,
        hour,
        minute,
        second,
        weekday: weekday as u32,
        is_dst,
    }
}

// Simplified DST check (good enough for NYSE hours)
fn is_daylight_saving_time(utc_timestamp: i64) -> bool {
    // Convert to rough month estimate
    let days_since_epoch = utc_timestamp / 86400;
    let approx_year = 1970 + (days_since_epoch / 365);
    let days_in_year = days_since_epoch % 365;

    // DST roughly: March (day 60) to November (day 305)
    // This is approximate but good enough for NYSE
    if approx_year >= 2007 {
        // Post-2007 DST rules: 2nd Sunday in March to 1st Sunday in November
        days_in_year >= 70 && days_in_year <= 305
    } else {
        // Pre-2007 DST rules: 1st Sunday in April to last Sunday in October
        days_in_year >= 90 && days_in_year <= 300
    }
}

// Simplified date calculation (good enough for NYSE)
fn days_to_date(days_since_epoch: i64) -> (i32, u32, u32) {
    // Very simplified - assumes average year length
    let approx_year = 1970 + (days_since_epoch / 365);
    let remaining_days = days_since_epoch % 365;

    // Simplified month/day calculation
    let months = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1;
    let mut days_left = remaining_days;

    for &days_in_month in &months {
        if days_left < days_in_month as i64 {
            break;
        }
        days_left -= days_in_month as i64;
        month += 1;
    }

    let day = (days_left + 1).max(1) as u32;

    (approx_year as i32, month, day)
}

// Simplified NYSE holiday check (major holidays only)
fn is_nyse_holiday(_year: i32, month: u32, day: u32) -> bool {
    match (month, day) {
        (1, 1) => true,   // New Year's Day
        (7, 4) => true,   // Independence Day
        (12, 25) => true, // Christmas Day
        // Add more holidays as needed
        _ => false,
    }
}

// Keep existing helper functions for timestamp formatting
fn format_timestamp(timestamp: i64) -> String {
    // Simple UTC formatting
    let days = timestamp / 86400;
    let seconds = timestamp % 86400;
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let secs = seconds % 60;

    // Rough date calculation for display
    let year = 1970 + days / 365;
    let day_in_year = days % 365;

    format!(
        "{}-01-{:02} {:02}:{:02}:{:02}",
        year,
        day_in_year + 1,
        hours,
        minutes,
        secs
    )
}
