use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        transfer_hook::TransferHookAccount, BaseStateWithExtensions, StateWithExtensions,
    },
    state::Account as Token2022Account,
};
use anchor_spl::token_interface;
use spl_tlv_account_resolution::{
    account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList,
};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

declare_id!("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");

#[cfg(test)]
mod market_tests;

/// Daylight-saving rule. Only the two that matter are implemented; everything
/// else is a fixed offset.
pub const DST_NONE: u8 = 0;
/// Second Sunday in March 02:00 local standard, to first Sunday in November
/// 02:00 local daylight. In force in the US since 2007.
pub const DST_US: u8 = 1;
/// Last Sunday in March 01:00 UTC to last Sunday in October 01:00 UTC.
pub const DST_EU: u8 = 2;

const MAX_WINDOWS: usize = 14;
const MAX_HOLIDAYS: usize = 256;
const MAX_EARLY_CLOSES: usize = 64;

#[program]
pub mod nyse_token_hook {
    use super::*;

    /// Write a mint's trading schedule and the hook's validation state.
    ///
    /// The schedule is written once and never mutated: there is no instruction
    /// to change it. A "market" is simply a preset the launcher supplies here,
    /// so new markets need no program upgrade, and changing a preset later
    /// cannot affect a token that has already launched.
    pub fn initialize(ctx: Context<Initialize>, args: ScheduleArgs) -> Result<()> {
        args.validate()?;

        let s = &mut ctx.accounts.schedule;
        s.mint = ctx.accounts.mint.key();
        s.tz_offset_minutes = args.tz_offset_minutes;
        s.dst_rule = args.dst_rule;
        s.base_day = args.base_day;
        s.windows = args.windows;
        s.holidays = args.holidays;
        s.early_closes = args.early_closes;

        // Token-2022 must pass the schedule account on every transfer.
        let account_metas = vec![ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal { bytes: b"schedule".to_vec() },
                Seed::AccountKey { index: 1 }, // the mint, in the Execute account list
            ],
            false,
            false,
        )?];

        let info = ctx.accounts.extra_account_meta_list.to_account_info();
        ExtraAccountMetaList::init::<ExecuteInstruction>(
            &mut info.try_borrow_mut_data()?,
            &account_metas,
        )?;

        msg!("schedule written for mint {}", s.mint);
        Ok(())
    }

    /// Runs on every Token-2022 transfer of a mint configured with this hook.
    pub fn transfer_hook(ctx: Context<TransferHook>, _amount: u64) -> Result<()> {
        // Token-2022 sets this flag only for the duration of a real transfer
        // CPI, so it rejects a direct call to Execute.
        assert_is_transferring(&ctx.accounts.source_token.to_account_info())?;

        let now = Clock::get()?.unix_timestamp;
        match ctx.accounts.schedule.state_at(now) {
            MarketState::Open => Ok(()),
            MarketState::Holiday => {
                msg!("market closed: holiday");
                err!(HookError::MarketClosedHoliday)
            }
            MarketState::Closed => {
                msg!("market closed: outside trading hours");
                err!(HookError::MarketClosed)
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
            _ => err!(HookError::UnsupportedInstruction),
        }
    }
}

fn assert_is_transferring(account_info: &AccountInfo) -> Result<()> {
    let data = account_info.try_borrow_data()?;
    let state = StateWithExtensions::<Token2022Account>::unpack(&data)
        .map_err(|_| error!(HookError::InvalidTokenAccount))?;
    let extension = state
        .get_extension::<TransferHookAccount>()
        .map_err(|_| error!(HookError::InvalidTokenAccount))?;

    if bool::from(extension.transferring) {
        Ok(())
    } else {
        err!(HookError::NotTransferring)
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(args: ScheduleArgs)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = Schedule::space(
            args.windows.len(),
            args.holidays.len(),
            args.early_closes.len(),
        ),
        seeds = [b"schedule", mint.key().as_ref()],
        bump
    )]
    pub schedule: Account<'info, Schedule>,

    /// CHECK: initialized here as a TLV ExtraAccountMetaList; seeds are checked.
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(1)?,
        seeds = [b"extra-account-metas", mint.key().as_ref()],
        bump
    )]
    pub extra_account_meta_list: AccountInfo<'info>,

    /// CHECK: only used for PDA derivation and recorded on the schedule.
    pub mint: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferHook<'info> {
    #[account(token::mint = mint)]
    pub source_token: InterfaceAccount<'info, token_interface::TokenAccount>,

    pub mint: InterfaceAccount<'info, token_interface::Mint>,

    #[account(token::mint = mint)]
    pub destination_token: InterfaceAccount<'info, token_interface::TokenAccount>,

    /// The transfer authority. NOT necessarily the source account's owner: for
    /// delegated transfers Token-2022 passes the delegate here.
    /// CHECK: not authorizing anything on it.
    pub authority: UncheckedAccount<'info>,

    /// CHECK: unused; present only to match the transfer-hook account layout.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// The mint's immutable trading schedule.
    #[account(seeds = [b"schedule", mint.key().as_ref()], bump)]
    pub schedule: Account<'info, Schedule>,
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/// One recurring weekly opening, in the market's local time.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Window {
    /// Bit 0 = Sunday ... bit 6 = Saturday.
    pub days_mask: u8,
    /// Minutes from local midnight, inclusive.
    pub open_minute: u16,
    /// Minutes from local midnight, exclusive.
    pub close_minute: u16,
}

/// A day that closes earlier than its window would allow.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct EarlyClose {
    /// Days after `base_day`.
    pub day_offset: u16,
    /// Minutes from local midnight, exclusive.
    pub close_minute: u16,
}

/// Instruction payload. Mirrors `Schedule` minus the mint.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ScheduleArgs {
    pub tz_offset_minutes: i16,
    pub dst_rule: u8,
    pub base_day: i32,
    pub windows: Vec<Window>,
    /// Full closures, as days after `base_day`, sorted ascending.
    pub holidays: Vec<u16>,
    pub early_closes: Vec<EarlyClose>,
}

impl ScheduleArgs {
    fn validate(&self) -> Result<()> {
        require!(!self.windows.is_empty(), HookError::NoWindows);
        require!(self.windows.len() <= MAX_WINDOWS, HookError::TooManyWindows);
        require!(self.holidays.len() <= MAX_HOLIDAYS, HookError::TooManyHolidays);
        require!(
            self.early_closes.len() <= MAX_EARLY_CLOSES,
            HookError::TooManyEarlyCloses
        );
        require!(self.dst_rule <= DST_EU, HookError::InvalidDstRule);
        require!(
            self.tz_offset_minutes >= -720 && self.tz_offset_minutes <= 840,
            HookError::InvalidTimezoneOffset
        );
        for w in &self.windows {
            require!(w.days_mask != 0, HookError::InvalidWindow);
            require!(w.open_minute < w.close_minute, HookError::InvalidWindow);
            require!(w.close_minute <= 1440, HookError::InvalidWindow);
        }
        // Binary search over holidays requires sorted input.
        require!(
            self.holidays.windows(2).all(|p| p[0] < p[1]),
            HookError::HolidaysNotSorted
        );
        Ok(())
    }
}

#[account]
pub struct Schedule {
    pub mint: Pubkey,
    pub tz_offset_minutes: i16,
    pub dst_rule: u8,
    pub base_day: i32,
    pub windows: Vec<Window>,
    pub holidays: Vec<u16>,
    pub early_closes: Vec<EarlyClose>,
}

impl Schedule {
    pub fn space(windows: usize, holidays: usize, early_closes: usize) -> usize {
        8  // discriminator
        + 32 // mint
        + 2  // tz_offset_minutes
        + 1  // dst_rule
        + 4  // base_day
        + 4 + windows * 5
        + 4 + holidays * 2
        + 4 + early_closes * 4
    }

    /// Market state at a UTC timestamp.
    pub fn state_at(&self, utc_ts: i64) -> MarketState {
        let offset_minutes = self.tz_offset_minutes as i64 + if self.is_dst(utc_ts) { 60 } else { 0 };
        let local = utc_ts + offset_minutes * 60;

        let day = local.div_euclid(86_400);
        let minute_of_day = (local.rem_euclid(86_400) / 60) as u16;
        let weekday = weekday_from_days(day);

        // Holidays and early closes are stored as offsets from base_day.
        let offset = day - self.base_day as i64;
        let day_offset: Option<u16> = if (0..=u16::MAX as i64).contains(&offset) {
            Some(offset as u16)
        } else {
            None
        };

        if let Some(d) = day_offset {
            if self.holidays.binary_search(&d).is_ok() {
                return MarketState::Holiday;
            }
        }

        let mut close = None;
        for w in self.windows.iter() {
            if w.days_mask & (1 << weekday) == 0 {
                continue;
            }
            if minute_of_day >= w.open_minute && minute_of_day < w.close_minute {
                close = Some(w.close_minute);
                break;
            }
        }
        let Some(mut close_minute) = close else {
            return MarketState::Closed;
        };

        if let Some(d) = day_offset {
            if let Some(ec) = self.early_closes.iter().find(|e| e.day_offset == d) {
                close_minute = close_minute.min(ec.close_minute);
            }
        }

        if minute_of_day < close_minute {
            MarketState::Open
        } else {
            MarketState::Closed
        }
    }

    fn is_dst(&self, utc_ts: i64) -> bool {
        match self.dst_rule {
            DST_US => {
                // Both boundaries are defined in LOCAL time, so convert each to
                // UTC and compare there. The start is 02:00 local *standard*
                // time; the end is 02:00 local *daylight* time, which is one
                // hour earlier in UTC terms.
                let off = self.tz_offset_minutes as i64 * 60;
                // Transitions sit far from 1 January, so the UTC year is safe.
                let (year, _, _) = civil_from_days(utc_ts.div_euclid(86_400));
                let start = days_from_civil(year, 3, nth_weekday(year, 3, 0, 2)) * 86_400
                    + 2 * 3_600
                    - off;
                let end = days_from_civil(year, 11, nth_weekday(year, 11, 0, 1)) * 86_400
                    + 2 * 3_600
                    - off
                    - 3_600;
                utc_ts >= start && utc_ts < end
            }
            DST_EU => {
                // Both EU transitions are defined in UTC, which makes this exact.
                let (year, _, _) = civil_from_days(utc_ts.div_euclid(86_400));
                let start = days_from_civil(year, 3, last_weekday(year, 3, 0)) * 86_400 + 3_600;
                let end = days_from_civil(year, 10, last_weekday(year, 10, 0)) * 86_400 + 3_600;
                utc_ts >= start && utc_ts < end
            }
            _ => false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketState {
    Open,
    Holiday,
    Closed,
}

#[error_code]
pub enum HookError {
    #[msg("market closed: outside trading hours")]
    MarketClosed,
    #[msg("market closed: holiday")]
    MarketClosedHoliday,
    #[msg("hook invoked outside of a transfer")]
    NotTransferring,
    #[msg("could not parse Token-2022 account state")]
    InvalidTokenAccount,
    #[msg("unsupported transfer hook instruction")]
    UnsupportedInstruction,
    #[msg("schedule must define at least one window")]
    NoWindows,
    #[msg("too many windows")]
    TooManyWindows,
    #[msg("too many holidays")]
    TooManyHolidays,
    #[msg("too many early closes")]
    TooManyEarlyCloses,
    #[msg("unknown daylight-saving rule")]
    InvalidDstRule,
    #[msg("timezone offset out of range")]
    InvalidTimezoneOffset,
    #[msg("window is malformed")]
    InvalidWindow,
    #[msg("holidays must be sorted ascending with no duplicates")]
    HolidaysNotSorted,
}

// ---------------------------------------------------------------------------
// Civil calendar: Howard Hinnant's algorithms, leap-year exact.
// http://howardhinnant.github.io/date_algorithms.html
// ---------------------------------------------------------------------------

pub fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = y - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64;
    let mp = ((m + 9) % 12) as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era as i64 * 146_097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    ((y + if m <= 2 { 1 } else { 0 }) as i32, m, d)
}

/// 0 = Sunday .. 6 = Saturday. 1970-01-01 was a Thursday.
pub fn weekday_from_days(days: i64) -> u32 {
    (days + 4).rem_euclid(7) as u32
}

/// Day-of-month of the `n`-th `weekday` (0 = Sunday) in the given month.
pub fn nth_weekday(year: i32, month: u32, weekday: u32, n: u32) -> u32 {
    let first = days_from_civil(year, month, 1);
    let offset = (weekday + 7 - weekday_from_days(first)) % 7;
    1 + offset + (n - 1) * 7
}

/// Day-of-month of the last `weekday` (0 = Sunday) in the given month.
pub fn last_weekday(year: i32, month: u32, weekday: u32) -> u32 {
    let (ny, nm) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let last = days_from_civil(ny, nm, 1) - 1;
    let back = (weekday_from_days(last) + 7 - weekday) % 7;
    let (_, _, dom) = civil_from_days(last - back as i64);
    dom
}
