//! Unit tests for the NYSE calendar logic.
//!
//! The `SESSIONS` table is generated from the IANA tz database (`America/New_York`)
//! rather than written by hand, so it is independent of the implementation under
//! test. See `scripts/gen_market_table.py`.

use super::*;

#[test]
fn civil_roundtrip_covers_leap_years() {
    // Every day for 12 years, including the 2028 leap day.
    let start = days_from_civil(2024, 1, 1);
    let end = days_from_civil(2036, 1, 1);
    for z in start..end {
        let (y, m, d) = civil_from_days(z);
        assert_eq!(days_from_civil(y, m, d), z, "roundtrip failed at {y}-{m:02}-{d:02}");
    }
}

#[test]
fn known_civil_dates() {
    assert_eq!(days_from_civil(1970, 1, 1), 0);
    assert_eq!(civil_from_days(0), (1970, 1, 1));
    // The leap day the old 365-day arithmetic could not represent.
    assert_eq!(civil_from_days(days_from_civil(2028, 2, 29)), (2028, 2, 29));
    assert_eq!(days_from_civil(2028, 3, 1) - days_from_civil(2028, 2, 28), 2);
    // 2100 is not a leap year.
    assert_eq!(days_from_civil(2100, 3, 1) - days_from_civil(2100, 2, 28), 1);
}

#[test]
fn weekdays_are_correct() {
    // 1970-01-01 was a Thursday.
    assert_eq!(weekday_from_days(0), 4);
    // 2026-09-28 is a Monday. The old code got this right but got the date wrong.
    assert_eq!(weekday_from_days(days_from_civil(2026, 9, 28)), 1);
    assert_eq!(weekday_from_days(days_from_civil(2026, 9, 26)), 6); // Saturday
    assert_eq!(weekday_from_days(days_from_civil(2026, 9, 27)), 0); // Sunday
}

#[test]
fn nth_and_last_weekday() {
    // Third Monday of January 2026 is the 19th.
    assert_eq!(nth_weekday(2026, 1, 1, 3), 19);
    // Fourth Thursday of November 2026 is the 26th.
    assert_eq!(nth_weekday(2026, 11, 4, 4), 26);
    // Last Monday of May 2026 is the 25th; of May 2027 the 31st.
    assert_eq!(last_weekday(2026, 5, 1), 25);
    assert_eq!(last_weekday(2027, 5, 1), 31);
    // Month-boundary case: last Sunday of December 2028.
    assert_eq!(last_weekday(2028, 12, 0), 31);
}

#[test]
fn easter_and_good_friday() {
    assert_eq!(easter(2026), (4, 5));
    assert_eq!(easter(2027), (3, 28));
    assert_eq!(easter(2028), (4, 16));
    assert_eq!(good_friday(2026), (4, 3));
    assert_eq!(good_friday(2027), (3, 26));
    assert_eq!(good_friday(2028), (4, 14));
}

#[test]
fn dst_transitions_are_exact() {
    // (dst_start_utc, dst_end_utc) verified against tzdata.
    let boundaries = [
        (2026, 1_772_953_200i64, 1_793_512_800i64),
        (2027, 1_805_007_600, 1_825_567_200),
        (2028, 1_836_457_200, 1_857_016_800),
    ];
    for (year, start, end) in boundaries {
        assert!(!is_eastern_dst(start - 1), "{year}: DST began a second early");
        assert!(is_eastern_dst(start), "{year}: DST did not begin on time");
        assert!(is_eastern_dst(end - 1), "{year}: DST ended a second early");
        assert!(!is_eastern_dst(end), "{year}: DST did not end on time");
    }
}

#[test]
fn new_years_on_saturday_is_not_observed() {
    // 2028-01-01 is a Saturday. NYSE Rule 7.2 does not move it to Dec 31, 2027.
    assert!(!is_full_closure(2028, 1, 1));
    assert!(!is_full_closure(2027, 12, 31));
    // But a Sunday New Year's does move to the Monday: 2033-01-01 is a Saturday,
    // 2034-01-01 is a Sunday -> observed Monday Jan 2.
    assert!(is_full_closure(2034, 1, 2));
    assert!(!is_full_closure(2034, 1, 1));
}

#[test]
fn christmas_eve_is_a_closure_only_when_observed() {
    // 2027-12-25 is a Saturday, so Dec 24 is the observed closure.
    assert!(is_full_closure(2027, 12, 24));
    // 2026-12-24 is a Thursday with Christmas on Friday. NYSE closes early that
    // day; we trade a full session, so it must not be a closure.
    assert!(!is_full_closure(2026, 12, 24));
}

#[test]
fn july_third_is_a_closure_only_when_observed() {
    // 2026-07-04 is a Saturday -> Jul 3 is the observed closure.
    assert!(is_full_closure(2026, 7, 3));
    // 2028-07-04 is a Tuesday -> Jul 3 is an NYSE half-day, which we do not
    // enforce, so it is a normal full trading day here.
    assert!(!is_full_closure(2028, 7, 3));
}

#[test]
fn market_state_table() {
    const SESSIONS: &[(i64, MarketState)] = &[
        // Every NYSE full closure 2026-2028, checked at 11:00 ET
        (1767283200, MarketState::Holiday),               // 2026-01-01 Thu 11:00 ET NewYears
        (1768838400, MarketState::Holiday),               // 2026-01-19 Mon 11:00 ET MLK
        (1771257600, MarketState::Holiday),               // 2026-02-16 Mon 11:00 ET Presidents
        (1775228400, MarketState::Holiday),               // 2026-04-03 Fri 11:00 ET GoodFriday
        (1779721200, MarketState::Holiday),               // 2026-05-25 Mon 11:00 ET Memorial
        (1781881200, MarketState::Holiday),               // 2026-06-19 Fri 11:00 ET Juneteenth
        (1783090800, MarketState::Holiday),               // 2026-07-03 Fri 11:00 ET Independence
        (1788793200, MarketState::Holiday),               // 2026-09-07 Mon 11:00 ET Labor
        (1795708800, MarketState::Holiday),               // 2026-11-26 Thu 11:00 ET Thanksgiving
        (1798214400, MarketState::Holiday),               // 2026-12-25 Fri 11:00 ET Christmas
        (1798819200, MarketState::Holiday),               // 2027-01-01 Fri 11:00 ET NewYears
        (1800288000, MarketState::Holiday),               // 2027-01-18 Mon 11:00 ET MLK
        (1802707200, MarketState::Holiday),               // 2027-02-15 Mon 11:00 ET Presidents
        (1806073200, MarketState::Holiday),               // 2027-03-26 Fri 11:00 ET GoodFriday
        (1811775600, MarketState::Holiday),               // 2027-05-31 Mon 11:00 ET Memorial
        (1813330800, MarketState::Holiday),               // 2027-06-18 Fri 11:00 ET Juneteenth
        (1814799600, MarketState::Holiday),               // 2027-07-05 Mon 11:00 ET Independence
        (1820242800, MarketState::Holiday),               // 2027-09-06 Mon 11:00 ET Labor
        (1827158400, MarketState::Holiday),               // 2027-11-25 Thu 11:00 ET Thanksgiving
        (1829664000, MarketState::Holiday),               // 2027-12-24 Fri 11:00 ET Christmas
        (1831737600, MarketState::Holiday),               // 2028-01-17 Mon 11:00 ET MLK
        (1834761600, MarketState::Holiday),               // 2028-02-21 Mon 11:00 ET Presidents
        (1839337200, MarketState::Holiday),               // 2028-04-14 Fri 11:00 ET GoodFriday
        (1843225200, MarketState::Holiday),               // 2028-05-29 Mon 11:00 ET Memorial
        (1845039600, MarketState::Holiday),               // 2028-06-19 Mon 11:00 ET Juneteenth
        (1846335600, MarketState::Holiday),               // 2028-07-04 Tue 11:00 ET Independence
        (1851692400, MarketState::Holiday),               // 2028-09-04 Mon 11:00 ET Labor
        (1858608000, MarketState::Holiday),               // 2028-11-23 Thu 11:00 ET Thanksgiving
        (1861372800, MarketState::Holiday),               // 2028-12-25 Mon 11:00 ET Christmas

        // NYSE half-days (13:00 ET close). We deliberately do NOT enforce these:
        // the session stays 09:30-16:00, so 15:00 ET is still Open.
        (1795802340, MarketState::Open),                  // 2026-11-27 Fri 12:59 ET DayAfterThanksgiving
        (1795802400, MarketState::Open),                  // 2026-11-27 Fri 13:00 ET DayAfterThanksgiving
        (1795809600, MarketState::Open),                  // 2026-11-27 Fri 15:00 ET DayAfterThanksgiving
        (1798135140, MarketState::Open),                  // 2026-12-24 Thu 12:59 ET ChristmasEve
        (1798135200, MarketState::Open),                  // 2026-12-24 Thu 13:00 ET ChristmasEve
        (1798142400, MarketState::Open),                  // 2026-12-24 Thu 15:00 ET ChristmasEve
        (1827251940, MarketState::Open),                  // 2027-11-26 Fri 12:59 ET DayAfterThanksgiving
        (1827252000, MarketState::Open),                  // 2027-11-26 Fri 13:00 ET DayAfterThanksgiving
        (1827259200, MarketState::Open),                  // 2027-11-26 Fri 15:00 ET DayAfterThanksgiving
        (1846256340, MarketState::Open),                  // 2028-07-03 Mon 12:59 ET July3
        (1846256400, MarketState::Open),                  // 2028-07-03 Mon 13:00 ET July3
        (1846263600, MarketState::Open),                  // 2028-07-03 Mon 15:00 ET July3
        (1858701540, MarketState::Open),                  // 2028-11-24 Fri 12:59 ET DayAfterThanksgiving
        (1858701600, MarketState::Open),                  // 2028-11-24 Fri 13:00 ET DayAfterThanksgiving
        (1858708800, MarketState::Open),                  // 2028-11-24 Fri 15:00 ET DayAfterThanksgiving

        // Regular session edges on an ordinary Monday
        (1790602140, MarketState::PreMarket),             // 2026-09-28 Mon 09:29 ET 
        (1790602200, MarketState::Open),                  // 2026-09-28 Mon 09:30 ET 
        (1790602260, MarketState::Open),                  // 2026-09-28 Mon 09:31 ET 
        (1790625540, MarketState::Open),                  // 2026-09-28 Mon 15:59 ET 
        (1790625600, MarketState::AfterHours),            // 2026-09-28 Mon 16:00 ET 
        (1790625660, MarketState::AfterHours),            // 2026-09-28 Mon 16:01 ET 
        (1790568000, MarketState::PreMarket),             // 2026-09-28 Mon 00:00 ET 
        (1790654340, MarketState::AfterHours),            // 2026-09-28 Mon 23:59 ET 

        // Weekend
        (1790434800, MarketState::Weekend),               // 2026-09-26 Sat 11:00 ET 
        (1790521200, MarketState::Weekend),               // 2026-09-27 Sun 11:00 ET 

        // Across both DST transitions: 09:30 and 15:59 ET must stay in session
        (1772807400, MarketState::Open),                  // 2026-03-06 Fri 09:30 ET 
        (1772830740, MarketState::Open),                  // 2026-03-06 Fri 15:59 ET 
        (1773063000, MarketState::Open),                  // 2026-03-09 Mon 09:30 ET 
        (1773086340, MarketState::Open),                  // 2026-03-09 Mon 15:59 ET 
        (1793367000, MarketState::Open),                  // 2026-10-30 Fri 09:30 ET 
        (1793390340, MarketState::Open),                  // 2026-10-30 Fri 15:59 ET 
        (1793629800, MarketState::Open),                  // 2026-11-02 Mon 09:30 ET 
        (1793653140, MarketState::Open),                  // 2026-11-02 Mon 15:59 ET 
        (1804861800, MarketState::Open),                  // 2027-03-12 Fri 09:30 ET 
        (1804885140, MarketState::Open),                  // 2027-03-12 Fri 15:59 ET 
        (1805117400, MarketState::Open),                  // 2027-03-15 Mon 09:30 ET 
        (1805140740, MarketState::Open),                  // 2027-03-15 Mon 15:59 ET 
        (1825421400, MarketState::Open),                  // 2027-11-05 Fri 09:30 ET 
        (1825444740, MarketState::Open),                  // 2027-11-05 Fri 15:59 ET 
        (1825684200, MarketState::Open),                  // 2027-11-08 Mon 09:30 ET 
        (1825707540, MarketState::Open),                  // 2027-11-08 Mon 15:59 ET 

        // Regression: dates the old 365-day-year math got wrong
        (1797004800, MarketState::Open),                  // 2026-12-11 Fri 11:00 ET old code falsely blocked as Christmas
        (1797000300, MarketState::Open),                  // 2026-12-11 Fri 09:45 ET old code falsely blocked as Christmas
        (1797609600, MarketState::Open),                  // 2026-12-18 Fri 11:00 ET old code falsely blocked as New Years
        (1797605100, MarketState::Open),                  // 2026-12-18 Fri 09:45 ET old code falsely blocked as New Years
        (1792508400, MarketState::Open),                  // 2026-10-20 Tue 11:00 ET old code had DST wrong -> window shifted
        (1792503900, MarketState::Open),                  // 2026-10-20 Tue 09:45 ET old code had DST wrong -> window shifted
        (1793372400, MarketState::Open),                  // 2026-10-30 Fri 11:00 ET old code had DST wrong -> window shifted
        (1793367900, MarketState::Open),                  // 2026-10-30 Fri 09:45 ET old code had DST wrong -> window shifted
    ];

    for &(ts, want) in SESSIONS {
        let got = nyse_market_state(ts);
        let et = eastern_time(ts);
        assert_eq!(
            got, want,
            "ts {ts} (ET {}-{:02}-{:02} {:02}:{:02}) expected {want:?}, got {got:?}",
            et.year, et.month, et.day, et.minute_of_day / 60, et.minute_of_day % 60
        );
    }
}

#[test]
fn old_bugs_stay_fixed() {
    // The 365-day-year drift put the program 14 days ahead, so these ordinary
    // trading days were blocked as holidays and the real holidays traded.
    assert_eq!(nyse_market_state(1_797_004_800), MarketState::Open); // 2026-12-11 Fri 11:00 ET
    assert_eq!(nyse_market_state(1_798_214_400), MarketState::Holiday); // 2026-12-25 Fri, real Christmas

    // The same drift fed the DST check, shifting the whole session by an hour
    // for ~46 days a year. 2026-10-20 09:45 ET must be open, 16:30 ET closed.
    assert_eq!(nyse_market_state(1_792_503_900), MarketState::Open);
    assert_eq!(nyse_market_state(1_792_528_200), MarketState::AfterHours);
}

#[test]
fn session_is_a_uniform_window_on_every_trading_day() {
    // Half-days are not enforced, so every trading day must open at 09:30 and
    // close at 16:00 with no exceptions.
    let start = days_from_civil(2026, 1, 1);
    let end = days_from_civil(2031, 1, 1);
    for z in start..end {
        let (y, m, d) = civil_from_days(z);
        let wd = weekday_from_days(z);
        if wd == 0 || wd == 6 || is_full_closure(y, m, d) {
            continue;
        }
        // Reconstruct a UTC instant for 09:29/09:30/15:59/16:00 local.
        let offset = if is_eastern_dst(z * 86_400 + 12 * 3_600) { 4 } else { 5 };
        let base = z * 86_400 + offset * 3_600;
        let at = |min: i64| base + min * 60;
        assert_eq!(nyse_market_state(at(9 * 60 + 29)), MarketState::PreMarket, "{y}-{m:02}-{d:02}");
        assert_eq!(nyse_market_state(at(9 * 60 + 30)), MarketState::Open, "{y}-{m:02}-{d:02}");
        assert_eq!(nyse_market_state(at(15 * 60 + 59)), MarketState::Open, "{y}-{m:02}-{d:02}");
        assert_eq!(nyse_market_state(at(16 * 60)), MarketState::AfterHours, "{y}-{m:02}-{d:02}");
    }
}

#[test]
fn every_minute_of_a_year_is_classified_consistently() {
    // Walk a full year minute by minute and assert the session is contiguous:
    // once a day opens it must not reopen after closing.
    let start = 1_767_225_600i64; // 2026-01-01T00:00:00Z
    let mut prev_day = i64::MIN;
    let mut seen_open = false;
    let mut seen_close_after_open = false;

    for i in 0..(365 * 24 * 60) {
        let ts = start + i * 60;
        let et = eastern_time(ts);
        let day = days_from_civil(et.year, et.month, et.day);
        if day != prev_day {
            prev_day = day;
            seen_open = false;
            seen_close_after_open = false;
        }
        match nyse_market_state(ts) {
            MarketState::Open => {
                assert!(
                    !seen_close_after_open,
                    "session reopened after closing on {}-{:02}-{:02}",
                    et.year, et.month, et.day
                );
                seen_open = true;
            }
            _ => {
                if seen_open {
                    seen_close_after_open = true;
                }
            }
        }
    }
}
