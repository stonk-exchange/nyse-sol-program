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


HORIZON_START = 2026
HORIZON_END = 2046  # inclusive


def days_from_civil(y, m, d):
    y -= m <= 2
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    mp = (m + 9) % 12
    doy = (153 * mp + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def emit_nyse_preset():
    """Emit the NYSE schedule as DATA: a base day plus holiday offsets.

    Calendars live in the launcher, not the program, so a new market needs no
    program upgrade. Holidays are precomputed to a fixed horizon; after that a
    token would trade on them, which is why the horizon is long.
    """
    base = days_from_civil(HORIZON_START, 1, 1)
    offsets = []
    for y in range(HORIZON_START, HORIZON_END + 1):
        for d in sorted(holidays(y)):
            off = days_from_civil(d.year, d.month, d.day) - base
            if 0 <= off <= 0xFFFF:
                offsets.append(off)
    offsets = sorted(set(offsets))
    last = base + offsets[-1]
    from datetime import date, timedelta
    last_date = date(1970, 1, 1) + timedelta(days=last)

    print("// Generated by scripts/gen_market_table.py -- do not edit by hand.")
    print("//")
    print(f"// NYSE, {HORIZON_START}-{HORIZON_END}. Holidays are stored as day offsets from")
    print(f"// base_day, so the program needs no calendar logic and new markets need no")
    print(f"// program upgrade. Last holiday covered: {last_date.isoformat()}.")
    print("#[cfg(test)]")
    print("pub fn nyse_schedule() -> Schedule {")
    print("    Schedule {")
    print("        mint: Pubkey::default(),")
    print("        tz_offset_minutes: -300, // EST; DST_US adds the hour")
    print("        dst_rule: DST_US,")
    print(f"        base_day: {base}, // {HORIZON_START}-01-01")
    print("        // Monday to Friday, 09:30-16:00 local.")
    print("        windows: vec![Window { days_mask: 0b0111110, open_minute: 570, close_minute: 960 }],")
    print("        holidays: vec![")
    for i in range(0, len(offsets), 12):
        print("            " + ", ".join(str(o) for o in offsets[i:i + 12]) + ",")
    print("        ],")
    print("        // NYSE half-days are deliberately not enforced.")
    print("        early_closes: vec![],")
    print("    }")
    print("}")
    print()


def emit_ts_presets():
    """Emit the market presets the launcher writes into each mint's schedule."""
    base = days_from_civil(HORIZON_START, 1, 1)
    offsets = []
    for y in range(HORIZON_START, HORIZON_END + 1):
        for d in sorted(holidays(y)):
            off = days_from_civil(d.year, d.month, d.day) - base
            if 0 <= off <= 0xFFFF:
                offsets.append(off)
    offsets = sorted(set(offsets))

    print("// Generated by scripts/gen_market_table.py --preset-ts. Do not edit by hand.")
    print("//")
    print("// A market is data, not code: the program is a schedule evaluator and")
    print("// never knows which market it is enforcing. Adding a market means adding")
    print("// a preset here, with no program upgrade and no new hook address.")
    print()
    print("/** Daylight-saving rule applied on top of the fixed offset. */")
    print("export const DstRule = { None: 0, US: 1, EU: 2 } as const;")
    print()
    print("export type Window = { daysMask: number; openMinute: number; closeMinute: number };")
    print("export type EarlyClose = { dayOffset: number; closeMinute: number };")
    print("export type Market = {")
    print("  id: string;")
    print("  label: string;")
    print("  tzOffsetMinutes: number;")
    print("  dstRule: number;")
    print("  baseDay: number;")
    print("  windows: Window[];")
    print("  holidays: number[];")
    print("  earlyCloses: EarlyClose[];")
    print("};")
    print()
    print("/** Monday to Friday. Bit 0 is Sunday. */")
    print("const MON_TO_FRI = 0b0111110;")
    print()
    print("export const MARKETS: Record<string, Market> = {")
    print("  nyse: {")
    print('    id: "nyse",')
    print('    label: "NYSE — 09:30-16:00 ET, Mon-Fri",')
    print("    tzOffsetMinutes: -300,")
    print("    dstRule: DstRule.US,")
    print(f"    baseDay: {base},")
    print("    windows: [{ daysMask: MON_TO_FRI, openMinute: 570, closeMinute: 960 }],")
    print("    holidays: [")
    for i in range(0, len(offsets), 16):
        print("      " + ", ".join(str(o) for o in offsets[i:i + 16]) + ",")
    print("    ],")
    print("    earlyCloses: [],")
    print("  },")
    print("};")
    print()
    print("export function market(id: string): Market {")
    print("  const m = MARKETS[id];")
    print("  if (!m) throw new Error(`unknown market '${id}'. known: ${Object.keys(MARKETS).join(\", \")}`);")
    print("  return m;")
    print("}")


def main():
    check_dst_assumptions()
    if "--check" in sys.argv:
        return
    if "--preset" in sys.argv:
        emit_nyse_preset()
        return
    if "--preset-ts" in sys.argv:
        emit_ts_presets()
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
