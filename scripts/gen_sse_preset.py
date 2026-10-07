#!/usr/bin/env python3
"""Generate the SSE (Shanghai Stock Exchange) schedule preset.

Unlike NYSE, this cannot be computed from rules. NYSE holidays follow fixed
patterns -- the third Monday in January, Good Friday, and so on -- so the
generator derives them decades ahead. Chinese market holidays are announced
annually by the State Council, follow the lunar calendar, and come with
make-up working weekends. There is no rule to extrapolate.

So the data comes from `exchange_calendars` (XSHG), which tracks the official
announcements. That library has a hard end date, and this script refuses to
emit a preset that pretends to know more than the library does.

    pip install exchange_calendars
    python3 scripts/gen_sse_preset.py            # print the TS preset
    python3 scripts/gen_sse_preset.py --horizon  # just report coverage

SSE trades 09:30-11:30 and 13:00-15:00 China Standard Time, Monday to Friday.
China has had no daylight saving since 1991, so the UTC offset is a constant
+08:00 and dstRule is DST_NONE -- which also means the two sessions never
shift, unlike NYSE's.
"""
import datetime
import sys

BASE_DAY = 20454  # 2026-01-01, the epoch holiday offsets are measured from
MON_TO_FRI = 0b0111110

try:
    import exchange_calendars as xc
    import pandas as pd
except ImportError:
    sys.exit("needs exchange_calendars: pip install exchange_calendars")


def sse_data():
    cal = xc.get_calendar("XSHG")
    base = datetime.date(1970, 1, 1) + datetime.timedelta(days=BASE_DAY)
    last = cal.last_session.date()
    if last <= base:
        sys.exit(f"calendar data ends {last}, before the base day {base}")

    sessions = cal.sessions_in_range(str(base), str(last))
    session_days = {s.date() for s in sessions}

    holidays, weekend_sessions = [], []
    day = base
    while day <= last:
        is_weekday = day.weekday() < 5
        trades = day in session_days
        if is_weekday and not trades:
            holidays.append((day - base).days)
        if not is_weekday and trades:
            # A make-up working weekend. The hook's weekly windows cover Mon-Fri
            # only, so these would be blocked. Reported rather than encoded:
            # falsely blocking a trading day is the safe direction, and encoding
            # them needs allow-events, which is a decision not a default.
            weekend_sessions.append(day)
        day += datetime.timedelta(days=1)
    return base, last, holidays, weekend_sessions, cal


def main():
    base, last, holidays, weekend_sessions, cal = sse_data()
    horizon_days = (last - datetime.date.today()).days

    if "--horizon" in sys.argv:
        print(f"XSHG data runs to      {last}")
        print(f"holidays from {base}  {len(holidays)}")
        print(f"horizon from today     {horizon_days} days")
        print(f"make-up weekend sessions in range: {len(weekend_sessions)}")
        for d in weekend_sessions:
            print(f"   {d}  (would be BLOCKED by the Mon-Fri windows)")
        return

    print("  // SSE -- Shanghai Stock Exchange.")
    print("  //")
    print("  // Two sessions a day with a lunch break, and no daylight saving:")
    print("  // China has been a constant UTC+8 since 1991.")
    print("  //")
    print(f"  // Holidays are from exchange_calendars (XSHG), which ends {last}.")
    print("  // Chinese market holidays are announced annually by the State")
    print("  // Council and follow the lunar calendar, so unlike NYSE they cannot")
    print("  // be extrapolated. Past the last date above this schedule still")
    print("  // enforces weekends and both sessions, but stops blocking holidays.")
    print("  // A token copies its schedule at launch and cannot be updated, so")
    print(f"  // only launch on this while {last} is comfortably ahead.")
    print("  sse: {")
    print('    id: "sse",')
    print('    label: "SSE \\u2014 09:30-11:30, 13:00-15:00 CST, Mon-Fri",')
    print("    tzOffsetMinutes: 480,")
    print("    dstRule: DstRule.None,")
    print(f"    baseDay: {BASE_DAY},")
    print("    windows: [")
    print(f"      {{ daysMask: MON_TO_FRI, openMinute: 570, closeMinute: 690 }},  // 09:30-11:30")
    print(f"      {{ daysMask: MON_TO_FRI, openMinute: 780, closeMinute: 900 }},  // 13:00-15:00")
    print("    ],")
    print("    holidays: [")
    for i in range(0, len(holidays), 12):
        print("      " + ", ".join(str(h) for h in holidays[i:i + 12]) + ",")
    print("    ],")
    print("    earlyCloses: [],")
    print("    events: [],")
    print("  },")
    print(f"  // {len(holidays)} holidays, {base} to {last}", file=sys.stderr)


if __name__ == "__main__":
    main()
