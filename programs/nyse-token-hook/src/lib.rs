use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions,
    },
    state::Account as Token2022Account,
};
use anchor_spl::token_interface;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

declare_id!("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");

#[cfg(test)]
mod market_tests;

/// Regular session: 09:30 ET.
const REGULAR_OPEN_MIN: u32 = 9 * 60 + 30;
/// Session close: 16:00 ET.
///
/// NYSE closes at 13:00 ET on a handful of days (July 3, the Friday after
/// Thanksgiving, Christmas Eve). This program deliberately does NOT enforce
/// those: the session is a uniform 09:30-16:00 on every trading day, so holders
/// are not surprised by an early close. `market_state_table` pins this choice.
const REGULAR_CLOSE_MIN: u32 = 16 * 60;

#[program]
pub mod nyse_token_hook {
    use super::*;

    /// Initialize the extra account metas for the transfer hook.
    ///
    /// This hook needs no extra accounts: the market calendar is computed from
    /// the on-chain `Clock`, so there is nothing to resolve.
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        let account_metas = vec![];
        let account_info = ctx.accounts.extra_account_meta_list.to_account_info();

        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut account_info.try_borrow_mut_data()?,
            &account_metas,
        )?;

        msg!("NYSE transfer hook initialized for mint {}", ctx.accounts.mint.key());
        Ok(())
    }

    /// Runs on every Token-2022 transfer of a mint configured with this hook.
    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        // Reject direct invocation: Token-2022 sets the `transferring` flag on
        // the source and destination accounts only for the duration of a real
        // transfer CPI. Without this, anyone can call `execute` directly.
        assert_is_transferring(&ctx.accounts.source_token.to_account_info())?;

        let now = Clock::get()?.unix_timestamp;

        match nyse_market_state(now) {
            MarketState::Open => Ok(()),
            MarketState::Weekend => {
                msg!("NYSE closed: weekend");
                err!(NyseError::MarketClosedWeekend)
            }
            MarketState::Holiday => {
                msg!("NYSE closed: exchange holiday");
                err!(NyseError::MarketClosedHoliday)
            }
            MarketState::PreMarket => {
                msg!("NYSE closed: before 09:30 ET");
                err!(NyseError::MarketClosedPreMarket)
            }
            MarketState::AfterHours => {
                msg!("NYSE closed: after session close");
                err!(NyseError::MarketClosedAfterHours)
            }
        }
    }

    /// Fallback dispatcher for the SPL transfer-hook interface, which uses its
    /// own instruction discriminators rather than Anchor's.
    pub fn fallback<'info>(
        program_id: &Pubkey,
        accounts: &'info [AccountInfo<'info>],
        data: &[u8],
    ) -> Result<()> {
        match TransferHookInstruction::unpack(data)? {
            TransferHookInstruction::Execute { amount } => {
                let amount_bytes = amount.to_le_bytes();
                __private::__global::transfer_hook(program_id, accounts, &amount_bytes)
            }
            _ => err!(NyseError::UnsupportedInstruction),
        }
    }
}

/// Verify the account is mid-transfer, i.e. we were invoked by Token-2022 as
/// part of an actual transfer rather than called directly.
fn assert_is_transferring(account_info: &AccountInfo) -> Result<()> {
    let data = account_info.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Account>::unpack(&data)
        .map_err(|_| error!(NyseError::InvalidTokenAccount))?;
    let extension = state
        .get_extension::<TransferHookAccount>()
        .map_err(|_| error!(NyseError::InvalidTokenAccount))?;

    if bool::from(extension.transferring) {
        Ok(())
    } else {
        err!(NyseError::NotTransferring)
    }
}

#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: initialized here as a TLV ExtraAccountMetaList; seeds are checked.
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(0)?,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    /// CHECK: only used for PDA derivation.
    pub mint: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferHook<'info> {
    /// Source token account.
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, token_interface::TokenAccount>,

    pub mint: InterfaceAccount<'info, token_interface::Mint>,

    /// Destination token account.
    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// The transfer authority. Note this is NOT necessarily the source account's
    /// owner -- for delegated transfers Token-2022 passes the delegate here, so
    /// constraining it to `source_token.owner` would break those transfers.
    /// CHECK: passed through from the transfer instruction; not authorizing anything here.
    pub authority: UncheckedAccount<'info>,

    /// The hook's validation-state PDA.
    ///
    /// Deliberately NOT constrained by seeds. An Anchor `bump` constraint
    /// performs `find_program_address` on chain, which costs ~3,000 CU per bump
    /// iteration on EVERY transfer -- unbounded in the worst case, since the
    /// canonical bump depends on the mint address.
    ///
    /// The check bought nothing. This hook's decision depends only on the
    /// clock: it never reads this account, and it applies the same rule to
    /// every mint. Token-2022 chooses which accounts to pass, and
    /// `assert_is_transferring` already rejects direct invocation.
    ///
    /// CHECK: unused; present only to match the transfer-hook account layout.
    pub extra_account_meta_list: UncheckedAccount<'info>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketState {
    Open,
    Weekend,
    Holiday,
    PreMarket,
    AfterHours,
}

#[error_code]
pub enum NyseError {
    #[msg("NYSE closed: weekend")]
    MarketClosedWeekend,
    #[msg("NYSE closed: exchange holiday")]
    MarketClosedHoliday,
    #[msg("NYSE closed: before 09:30 ET")]
    MarketClosedPreMarket,
    #[msg("NYSE closed: after session close")]
    MarketClosedAfterHours,
    #[msg("Hook invoked outside of a transfer")]
    NotTransferring,
    #[msg("Could not parse Token-2022 account state")]
    InvalidTokenAccount,
    #[msg("Unsupported transfer hook instruction")]
    UnsupportedInstruction,
}

// ---------------------------------------------------------------------------
// Civil calendar
//
// Howard Hinnant's days_from_civil / civil_from_days. Proleptic Gregorian,
// leap-year exact, no lookup tables, no allocation.
// http://howardhinnant.github.io/date_algorithms.html
// ---------------------------------------------------------------------------

/// Days since 1970-01-01 for a civil date.
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64; // [0, 399]
    let mp = ((m + 9) % 12) as i64; // March = 0
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era as i64 * 146_097 + doe - 719_468
}

/// Civil date from days since 1970-01-01.
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    ((y + if m <= 2 { 1 } else { 0 }) as i32, m, d)
}

/// 0 = Sunday .. 6 = Saturday. 1970-01-01 was a Thursday.
fn weekday_from_days(days: i64) -> u32 {
    (days + 4).rem_euclid(7) as u32
}

/// Day-of-month of the `n`-th `weekday` (0 = Sunday) in the given month.
fn nth_weekday(year: i32, month: u32, weekday: u32, n: u32) -> u32 {
    let first = days_from_civil(year, month, 1);
    let offset = (weekday + 7 - weekday_from_days(first)) % 7;
    1 + offset + (n - 1) * 7
}

/// Day-of-month of the last `weekday` (0 = Sunday) in the given month.
fn last_weekday(year: i32, month: u32, weekday: u32) -> u32 {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let last = days_from_civil(ny, nm, 1) - 1;
    let back = (weekday_from_days(last) + 7 - weekday) % 7;
    let (_, _, dom) = civil_from_days(last - back as i64);
    dom
}

/// Easter Sunday, anonymous Gregorian algorithm (Meeus/Jones/Butcher).
fn easter(year: i32) -> (u32, u32) {
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
    (month as u32, day as u32)
}

/// NYSE observance rule: a holiday on Saturday moves to the preceding Friday,
/// one on Sunday to the following Monday.
fn observed(year: i32, month: u32, day: u32) -> (u32, u32) {
    let days = days_from_civil(year, month, day);
    let shift = match weekday_from_days(days) {
        6 => -1, // Saturday -> Friday
        0 => 1,  // Sunday -> Monday
        _ => 0,
    };
    let (_, m, d) = civil_from_days(days + shift);
    (m, d)
}

// ---------------------------------------------------------------------------
// Eastern Time
// ---------------------------------------------------------------------------

/// US DST since the Energy Policy Act of 2005 (in force from 2007):
/// second Sunday in March 02:00 EST (07:00 UTC) through
/// first Sunday in November 02:00 EDT (06:00 UTC).
///
/// Only the post-2007 rule is implemented; this program reads the on-chain
/// clock, so it is never evaluated against historical dates.
fn is_eastern_dst(utc_ts: i64) -> bool {
    let (year, _, _) = civil_from_days(utc_ts.div_euclid(86_400));

    let start_day = nth_weekday(year, 3, 0, 2);
    let start = days_from_civil(year, 3, start_day) * 86_400 + 7 * 3_600;

    let end_day = nth_weekday(year, 11, 0, 1);
    let end = days_from_civil(year, 11, end_day) * 86_400 + 6 * 3_600;

    utc_ts >= start && utc_ts < end
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EasternTime {
    year: i32,
    month: u32,
    day: u32,
    /// 0 = Sunday .. 6 = Saturday
    weekday: u32,
    /// Minutes since local midnight.
    minute_of_day: u32,
}

fn eastern_time(utc_ts: i64) -> EasternTime {
    let offset = if is_eastern_dst(utc_ts) { -4 * 3_600 } else { -5 * 3_600 };
    let local = utc_ts + offset;

    let days = local.div_euclid(86_400);
    let secs = local.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);

    EasternTime {
        year,
        month,
        day,
        weekday: weekday_from_days(days),
        minute_of_day: (secs / 60) as u32,
    }
}

// ---------------------------------------------------------------------------
// NYSE calendar
// ---------------------------------------------------------------------------

/// Full-day exchange closures.
fn is_full_closure(year: i32, month: u32, day: u32) -> bool {
    let md = (month, day);

    // New Year's Day. Per NYSE Rule 7.2 a Saturday New Year's is NOT observed
    // on the preceding Friday, since that falls in the prior year.
    let new_years = {
        let wd = weekday_from_days(days_from_civil(year, 1, 1));
        if wd == 6 {
            None
        } else {
            Some(observed(year, 1, 1))
        }
    };
    if new_years == Some(md) {
        return true;
    }

    if md == (1, nth_weekday(year, 1, 1, 3)) {
        return true; // Martin Luther King Jr. Day
    }
    if md == (2, nth_weekday(year, 2, 1, 3)) {
        return true; // Washington's Birthday
    }
    if md == good_friday(year) {
        return true;
    }
    if md == (5, last_weekday(year, 5, 1)) {
        return true; // Memorial Day
    }
    if md == observed(year, 6, 19) {
        return true; // Juneteenth
    }
    if md == observed(year, 7, 4) {
        return true; // Independence Day
    }
    if md == (9, nth_weekday(year, 9, 1, 1)) {
        return true; // Labor Day
    }
    if md == (11, nth_weekday(year, 11, 4, 4)) {
        return true; // Thanksgiving
    }
    if md == observed(year, 12, 25) {
        return true; // Christmas
    }

    false
}

fn good_friday(year: i32) -> (u32, u32) {
    let (em, ed) = easter(year);
    let (_, m, d) = civil_from_days(days_from_civil(year, em, ed) - 2);
    (m, d)
}

/// The market state at a given UTC timestamp.
pub fn nyse_market_state(utc_ts: i64) -> MarketState {
    let et = eastern_time(utc_ts);

    if et.weekday == 0 || et.weekday == 6 {
        return MarketState::Weekend;
    }

    if is_full_closure(et.year, et.month, et.day) {
        return MarketState::Holiday;
    }

    if et.minute_of_day < REGULAR_OPEN_MIN {
        MarketState::PreMarket
    } else if et.minute_of_day < REGULAR_CLOSE_MIN {
        MarketState::Open
    } else {
        MarketState::AfterHours
    }
}
