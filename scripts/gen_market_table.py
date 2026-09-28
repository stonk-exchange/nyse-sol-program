#!/usr/bin/env python3
"""Generate the market-state test table in programs/nyse-token-hook/src/market_tests.rs.

The expected values come from the IANA tz database (America/New_York) plus the
NYSE holiday rules, so the table is independent of the Rust implementation it
checks. Requires Python 3.9+ (zoneinfo).

Usage:  python3 scripts/gen_market_table.py          # print the table
        python3 scripts/gen_market_table.py --check  # verify tz assumptions only
"""
import datetime
import sys
import zoneinfo

ET = zoneinfo.ZoneInfo("America/New_York")


def easter(y):
    a, b, c = y % 19, y // 100, y % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    return datetime.date(y, (h + l - 7 * m + 114) // 31, ((h + l - 7 * m + 114) % 31) + 1)


def nth_wd(y, mo, weekday, n):
    """weekday uses Python's Monday=0 convention."""
    d = datetime.date(y, mo, 1)
    return d + datetime.timedelta(days=(weekday - d.weekday()) % 7 + 7 * (n - 1))


def last_wd(y, mo, weekday):
    nxt = datetime.date(y + 1, 1, 1) if mo == 12 else datetime.date(y, mo + 1, 1)
    d = nxt - datetime.timedelta(days=1)
    return d - datetime.timedelta(days=(d.weekday() - weekday) % 7)


def observed(d):
    if d.weekday() == 5:
        return d - datetime.timedelta(days=1)  # Saturday -> Friday
    if d.weekday() == 6:
        return d + datetime.timedelta(days=1)  # Sunday -> Monday
    return d


def holidays(y):
    out = {}
    ny = datetime.date(y, 1, 1)
    # NYSE Rule 7.2: a Saturday New Year's is not observed on the prior Dec 31.
    if ny.weekday() != 5:
        out[observed(ny)] = "NewYears"
    out[nth_wd(y, 1, 0, 3)] = "MLK"
    out[nth_wd(y, 2, 0, 3)] = "Presidents"
    out[easter(y) - datetime.timedelta(days=2)] = "GoodFriday"
    out[last_wd(y, 5, 0)] = "Memorial"
    out[observed(datetime.date(y, 6, 19))] = "Juneteenth"
    out[observed(datetime.date(y, 7, 4))] = "Independence"
    out[nth_wd(y, 9, 0, 1)] = "Labor"
    out[nth_wd(y, 11, 3, 4)] = "Thanksgiving"
    out[observed(datetime.date(y, 12, 25))] = "Christmas"
    return out


def early_closes(y):
    h, out = holidays(y), {}
    j3 = datetime.date(y, 7, 3)
    if j3.weekday() < 5 and j3 not in h:
        out[j3] = "July3"
    tg = nth_wd(y, 11, 3, 4)
    out[tg + datetime.timedelta(days=1)] = "DayAfterThanksgiving"
    d24 = datetime.date(y, 12, 24)
    if d24.weekday() < 5 and d24 not in h:
        out[d24] = "ChristmasEve"
    return out


def expected(y, mo, d, h, mi):
    day = datetime.date(y, mo, d)
    if day.weekday() >= 5:
        return "Weekend"
    if day in holidays(y):
        return "Holiday"
    # Uniform 16:00 close: NYSE half-days are deliberately not enforced.
    cm = h * 60 + mi
    if cm < 9 * 60 + 30:
        return "PreMarket"
    return "Open" if cm < 16 * 60 else "AfterHours"


def ts_at(y, mo, d, h, mi):
    return int(datetime.datetime(y, mo, d, h, mi, tzinfo=ET).timestamp())


def check_dst_assumptions():
    """The Rust code hardcodes the post-2007 DST rule; confirm it against tzdata."""
    for y in range(2026, 2036):
        start = nth_wd(y, 3, 6, 2)
        end = nth_wd(y, 11, 6, 1)
        s = int(datetime.datetime(start.year, start.month, start.day, 7, 0,
                                  tzinfo=datetime.timezone.utc).timestamp())
        e = int(datetime.datetime(end.year, end.month, end.day, 6, 0,
                                  tzinfo=datetime.timezone.utc).timestamp())
        assert datetime.datetime.fromtimestamp(s - 1, ET).dst() == datetime.timedelta(0), y
        assert datetime.datetime.fromtimestamp(s, ET).dst() == datetime.timedelta(hours=1), y
        assert datetime.datetime.fromtimestamp(e - 1, ET).dst() == datetime.timedelta(hours=1), y
        assert datetime.datetime.fromtimestamp(e, ET).dst() == datetime.timedelta(0), y
    # stderr, so that stdout is only ever the generated table.
    print("DST rule matches tzdata for 2026-2035 (America/New_York)", file=sys.stderr)


def main():
    check_dst_assumptions()
    if "--check" in sys.argv:
        return

    lines = []

    def case(y, mo, d, h, mi, note=""):
        ts, ex = ts_at(y, mo, d, h, mi), expected(y, mo, d, h, mi)
        wd = datetime.date(y, mo, d).strftime("%a")
        c = f"        ({ts}, MarketState::{ex}),"
        lines.append(f"{c}{' ' * max(1, 58 - len(c))}// {y}-{mo:02d}-{d:02d} {wd} {h:02d}:{mi:02d} ET {note}")

    lines.append("        // Every NYSE full closure 2026-2028, checked at 11:00 ET")
    for y in (2026, 2027, 2028):
        for dt, name in sorted(holidays(y).items()):
            case(dt.year, dt.month, dt.day, 11, 0, name)

    lines.append("")
    lines.append("        // NYSE half-days (13:00 ET close). We deliberately do NOT enforce these:")
    lines.append("        // the session stays 09:30-16:00, so 15:00 ET is still Open.")
    for y in (2026, 2027, 2028):
        for dt, name in sorted(early_closes(y).items()):
            for h, mi in ((12, 59), (13, 0), (15, 0)):
                case(dt.year, dt.month, dt.day, h, mi, name)

    lines.append("")
    lines.append("        // Regular session edges on an ordinary Monday")
    for h, mi in ((9, 29), (9, 30), (9, 31), (15, 59), (16, 0), (16, 1), (0, 0), (23, 59)):
        case(2026, 9, 28, h, mi)

    lines.append("")
    lines.append("        // Weekend")
    for y, mo, d in ((2026, 9, 26), (2026, 9, 27)):
        case(y, mo, d, 11, 0)

    lines.append("")
    lines.append("        // Across both DST transitions: 09:30 and 15:59 ET must stay in session")
    for y, mo, d in ((2026, 3, 6), (2026, 3, 9), (2026, 10, 30), (2026, 11, 2),
                     (2027, 3, 12), (2027, 3, 15), (2027, 11, 5), (2027, 11, 8)):
        case(y, mo, d, 9, 30)
        case(y, mo, d, 15, 59)

    lines.append("")
    lines.append("        // Regression: dates the old 365-day-year math got wrong")
    for y, mo, d, note in ((2026, 12, 11, "old code falsely blocked as Christmas"),
                           (2026, 12, 18, "old code falsely blocked as New Years"),
                           (2027, 6, 20, "old code falsely blocked as July 4th"),
                           (2026, 10, 20, "old code had DST wrong -> window shifted"),
                           (2026, 10, 30, "old code had DST wrong -> window shifted")):
        if datetime.date(y, mo, d).weekday() < 5:
            case(y, mo, d, 11, 0, note)
            case(y, mo, d, 9, 45, note)

    print("\n".join(lines))


if __name__ == "__main__":
    main()
