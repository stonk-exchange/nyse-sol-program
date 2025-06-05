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
    // Convert timestamp to Eastern Time components
    let et_time = convert_utc_to_eastern(timestamp)?;

    msg!(
        "🕐 Eastern Time: {}-{:02}-{:02} {:02}:{:02}:{:02} {}",
        et_time.year,
        et_time.month,
        et_time.day,
        et_time.hour,
        et_time.minute,
        et_time.second,
        if et_time.is_dst { "EDT" } else { "EST" }
    );

    // Check weekend (Saturday = 6, Sunday = 0)
    if et_time.weekday == 0 || et_time.weekday == 6 {
        return Ok(MarketState {
            is_open: false,
            status: "WEEKEND".to_string(),
            reason: "Weekend".to_string(),
        });
    }

    // Check holidays
    if let Some(holiday_name) =
        check_nyse_holiday(et_time.year, et_time.month, et_time.day, et_time.weekday)?
    {
        return Ok(MarketState {
            is_open: false,
            status: "HOLIDAY".to_string(),
            reason: holiday_name,
        });
    }

    // Check market hours (9:30 AM - 4:00 PM ET)
    let current_minutes = et_time.hour * 60 + et_time.minute;
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

// Eastern Time structure
#[derive(Debug)]
struct EasternTime {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    weekday: u32, // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    is_dst: bool,
}

// Convert UTC timestamp to Eastern Time with proper DST handling
fn convert_utc_to_eastern(utc_timestamp: i64) -> Result<EasternTime> {
    // Get UTC components
    let days_since_epoch = utc_timestamp / 86400;
    let seconds_today = utc_timestamp % 86400;

    // Handle negative seconds (before midnight)
    let (days_since_epoch, _) = if seconds_today < 0 {
        (days_since_epoch - 1, seconds_today + 86400)
    } else {
        (days_since_epoch, seconds_today)
    };

    // Calculate date from days since epoch (1970-01-01)
    let (year, month, day, weekday) = days_since_epoch_to_date(days_since_epoch)?;

    // Check if DST is in effect
    let is_dst = is_dst_in_effect(year, month, day, weekday);

    // Convert UTC to Eastern Time
    let eastern_offset_hours = if is_dst { -4 } else { -5 }; // EDT = UTC-4, EST = UTC-5
    let eastern_timestamp = utc_timestamp + (eastern_offset_hours * 3600);
    let eastern_seconds_today = ((eastern_timestamp % 86400) + 86400) % 86400;

    let hour = (eastern_seconds_today / 3600) as u32;
    let minute = ((eastern_seconds_today % 3600) / 60) as u32;
    let second = (eastern_seconds_today % 60) as u32;

    Ok(EasternTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
        weekday,
        is_dst,
    })
}

// Convert days since epoch to calendar date
fn days_since_epoch_to_date(days: i64) -> Result<(i32, u32, u32, u32)> {
    let mut year = 1970;
    let mut remaining_days = days;

    // Handle negative days (before 1970)
    if days < 0 {
        year = 1969;
        remaining_days = days + 365; // 1969 was not a leap year
        while remaining_days < 0 {
            year -= 1;
            let year_days = if is_leap_year(year) { 366 } else { 365 };
            remaining_days += year_days;
        }
    } else {
        // Handle positive days (after 1970)
        loop {
            let year_days = if is_leap_year(year) { 366 } else { 365 };
            if remaining_days < year_days {
                break;
            }
            remaining_days -= year_days;
            year += 1;
        }
    }

    // Convert remaining days to month and day
    let days_in_months = if is_leap_year(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 1;
    for &days_in_month in &days_in_months {
        if remaining_days < days_in_month as i64 {
            break;
        }
        remaining_days -= days_in_month as i64;
        month += 1;
    }

    let day = remaining_days + 1; // Days are 1-indexed

    // Calculate weekday (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
    // January 1, 1970 was a Thursday (4)
    let weekday = ((days + 4) % 7 + 7) % 7; // Handle negative modulo

    Ok((year, month, day as u32, weekday as u32))
}

// Check if a year is a leap year
fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

// Determine if DST is in effect for Eastern Time
fn is_dst_in_effect(year: i32, month: u32, day: u32, _weekday: u32) -> bool {
    // DST in Eastern Time: Second Sunday in March to First Sunday in November

    if month < 3 || month > 11 {
        return false; // January, February, December
    }

    if month > 3 && month < 11 {
        return true; // April through October
    }

    if month == 3 {
        // March: DST starts second Sunday
        let second_sunday = get_nth_weekday_of_month(year, 3, 0, 2); // 0 = Sunday, 2nd occurrence
        return day >= second_sunday;
    }

    if month == 11 {
        // November: DST ends first Sunday
        let first_sunday = get_nth_weekday_of_month(year, 11, 0, 1); // 0 = Sunday, 1st occurrence
        return day < first_sunday;
    }

    false
}

// Get the date of the nth occurrence of a weekday in a month
fn get_nth_weekday_of_month(year: i32, month: u32, target_weekday: u32, occurrence: u32) -> u32 {
    let mut count = 0;
    let days_in_month = get_days_in_month(year, month);

    for day in 1..=days_in_month {
        // Calculate weekday for this date
        let days_since_epoch = date_to_days_since_epoch(year, month, day);
        let weekday = ((days_since_epoch + 4) % 7 + 7) % 7; // January 1, 1970 was Thursday (4)

        if weekday as u32 == target_weekday {
            count += 1;
            if count == occurrence {
                return day;
            }
        }
    }

    1 // Fallback
}

// Get number of days in a month
fn get_days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

// Convert date to days since epoch
fn date_to_days_since_epoch(year: i32, month: u32, day: u32) -> i64 {
    let mut days = 0i64;

    // Add days for complete years
    for y in 1970..year {
        days += if is_leap_year(y) { 366 } else { 365 };
    }

    // Add days for complete months in the current year
    let days_in_months = if is_leap_year(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    for m in 1..month {
        days += days_in_months[(m - 1) as usize] as i64;
    }

    // Add remaining days
    days += (day - 1) as i64;

    days
}

// Comprehensive NYSE Holiday Check
fn check_nyse_holiday(year: i32, month: u32, day: u32, weekday: u32) -> Result<Option<String>> {
    // New Year's Day (January 1, or next Monday if weekend)
    if month == 1 {
        if day == 1 && weekday != 0 && weekday != 6 {
            return Ok(Some("New Year's Day".to_string()));
        }
        if day == 2 && weekday == 1 {
            // Monday after New Year's weekend
            return Ok(Some("New Year's Day (Observed)".to_string()));
        }
        if day == 3 && weekday == 1 {
            // Monday when Jan 1 is Sunday
            return Ok(Some("New Year's Day (Observed)".to_string()));
        }
    }

    // Martin Luther King Jr. Day (3rd Monday in January)
    if month == 1 {
        let third_monday = get_nth_weekday_of_month(year, 1, 1, 3); // 1 = Monday
        if day == third_monday {
            return Ok(Some("Martin Luther King Jr. Day".to_string()));
        }
    }

    // Washington's Birthday/Presidents Day (3rd Monday in February)
    if month == 2 {
        let third_monday = get_nth_weekday_of_month(year, 2, 1, 3);
        if day == third_monday {
            return Ok(Some("Presidents Day".to_string()));
        }
    }

    // Good Friday (Friday before Easter) - Complex calculation
    if let Some(easter_date) = get_easter_date(year) {
        if month == easter_date.0 && day == easter_date.1 - 2 && weekday == 5 {
            return Ok(Some("Good Friday".to_string()));
        }
    }

    // Memorial Day (Last Monday in May)
    if month == 5 {
        let last_monday = get_last_weekday_of_month(year, 5, 1);
        if day == last_monday {
            return Ok(Some("Memorial Day".to_string()));
        }
    }

    // Juneteenth (June 19, or next Monday if weekend)
    if month == 6 {
        if day == 19 && weekday != 0 && weekday != 6 {
            return Ok(Some("Juneteenth".to_string()));
        }
        if day == 20 && weekday == 1 {
            // Monday after weekend
            return Ok(Some("Juneteenth (Observed)".to_string()));
        }
        if day == 21 && weekday == 1 {
            // Monday when June 19 is Sunday
            return Ok(Some("Juneteenth (Observed)".to_string()));
        }
    }

    // Independence Day (July 4, or next Monday if weekend)
    if month == 7 {
        if day == 4 && weekday != 0 && weekday != 6 {
            return Ok(Some("Independence Day".to_string()));
        }
        if day == 5 && weekday == 1 {
            // Monday after weekend
            return Ok(Some("Independence Day (Observed)".to_string()));
        }
        if day == 6 && weekday == 1 {
            // Monday when July 4 is Sunday
            return Ok(Some("Independence Day (Observed)".to_string()));
        }
    }

    // Labor Day (1st Monday in September)
    if month == 9 {
        let first_monday = get_nth_weekday_of_month(year, 9, 1, 1);
        if day == first_monday {
            return Ok(Some("Labor Day".to_string()));
        }
    }

    // Thanksgiving (4th Thursday in November)
    if month == 11 {
        let fourth_thursday = get_nth_weekday_of_month(year, 11, 4, 4); // 4 = Thursday
        if day == fourth_thursday {
            return Ok(Some("Thanksgiving Day".to_string()));
        }
    }

    // Christmas Day (December 25, or next Monday if weekend)
    if month == 12 {
        if day == 25 && weekday != 0 && weekday != 6 {
            return Ok(Some("Christmas Day".to_string()));
        }
        if day == 26 && weekday == 1 {
            // Monday after weekend
            return Ok(Some("Christmas Day (Observed)".to_string()));
        }
        if day == 27 && weekday == 1 {
            // Monday when Dec 25 is Sunday
            return Ok(Some("Christmas Day (Observed)".to_string()));
        }
    }

    Ok(None)
}

// Get last occurrence of weekday in month
fn get_last_weekday_of_month(year: i32, month: u32, target_weekday: u32) -> u32 {
    let days_in_month = get_days_in_month(year, month);

    for day in (1..=days_in_month).rev() {
        let days_since_epoch = date_to_days_since_epoch(year, month, day);
        let weekday = ((days_since_epoch + 4) % 7 + 7) % 7;

        if weekday as u32 == target_weekday {
            return day;
        }
    }

    1 // Fallback
}

// Calculate Easter date (simplified algorithm)
fn get_easter_date(year: i32) -> Option<(u32, u32)> {
    // Simplified Easter calculation (Gregorian calendar)
    let a = year % 19;
    let b = year / 100;
    let c = year % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * m + 114) / 31;
    let day = ((h + l - 7 * m + 114) % 31) + 1;

    Some((month as u32, day as u32))
}

fn format_timestamp(timestamp: i64) -> String {
    let days_since_epoch = timestamp / 86400;
    let seconds_today = ((timestamp % 86400) + 86400) % 86400;

    if let Ok((year, month, day, _)) = days_since_epoch_to_date(days_since_epoch) {
        let hour = seconds_today / 3600;
        let minute = (seconds_today % 3600) / 60;
        let second = seconds_today % 60;

        format!(
            "{}-{:02}-{:02} {:02}:{:02}:{:02}",
            year, month, day, hour, minute, second
        )
    } else {
        "Invalid timestamp".to_string()
    }
}
