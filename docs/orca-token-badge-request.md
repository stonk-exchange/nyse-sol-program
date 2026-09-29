# TokenBadge request — NYSE trading-hours transfer hook

## Summary

We are launching a Token-2022 mint whose transfers are restricted to NYSE
trading hours by a transfer hook, and we would like to open a TokenBadge
conversation for it on Whirlpools.

**The part you should know first:** this hook rejects transfers by design. It
permits them Monday–Friday 09:30–16:00 ET and returns an error at every other
moment, which is roughly **81% of wall-clock time**. That is unlike the
allowlist and accounting hooks a badge is usually requested for, and we would
rather you hear it from us than discover it after issuing a badge. If a
deliberately-reverting hook is not something you are willing to badge, we would
like to know that early.

- **Program:** `CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k` (devnet today)
- **Extensions:** `TransferHook`, `MetadataPointer`, `TokenMetadata`
- **Source:** https://github.com/stonk-exchange/nyse-sol-program

## What the hook does

On every transfer, Token-2022 CPIs into the program. It derives the current
NYSE session from `Clock::unix_timestamp` and returns `Ok` or an `Err`. It is
stateless: no config account, no admin instructions, nothing to tune after
deployment, and no authority that can change its behaviour.

Permitted: Monday–Friday, 09:30–16:00 ET.
Blocked: weekends, the ten NYSE holidays, and outside the session.

Failures are clean `Err` returns with stable codes, never a panic and never a
partially applied state:

| Code | Error |
| --- | --- |
| 6000 | `MarketClosedWeekend` |
| 6001 | `MarketClosedHoliday` |
| 6002 | `MarketClosedPreMarket` |
| 6003 | `MarketClosedAfterHours` |
| 6004 | `NotTransferring` (Execute called outside a transfer) |

## We have tested this against your program

Rather than ask you to take our word for it, we ran the mint against the real
mainnet Whirlpool binary and your live `WhirlpoolsConfig`, loaded into LiteSVM.
Only the config's authorities were repointed so the test could issue itself a
badge; your program is unmodified. This is reproducible from the repo
(`npm run fetch:orca && npm run test:orca`):

| Step | Result |
| --- | --- |
| `initializePoolV2` without a badge | rejected, `UnsupportedTokenMint` (6047) |
| `initializePoolV2` with a badge | pool created |
| `increaseLiquidityV2` in session | liquidity added |
| `swapV2` in session | succeeds |
| `swapV2` at 16:30 ET | rejected, `MarketClosedAfterHours` (6003) |
| `swapV2` on a Saturday | rejected, `MarketClosedWeekend` (6000) |
| `swapV2` when the market reopens | succeeds again |
| `decreaseLiquidityV2` / `collectFeesV2` on a Saturday | rejected |
| both, once the market reopens | succeed |

## Compute budget

We built two identical Whirlpools — one hooked, one not — and ran the same
operations on both, so the delta is the hook's marginal cost:

| Operation | No hook | With hook | Delta |
| --- | ---: | ---: | ---: |
| `increaseLiquidityV2` | ~23k | ~60k | +37k |
| `swapV2`, within one tick array | ~48k | ~96k | +48k |
| `swapV2`, crossing ~3 tick arrays | ~73k | ~121k | +48k |
| `twoHopSwapV2` | ~82k | ~127k | +45k |

The cost is near-constant in swap size, because the hook runs once per transfer
rather than once per tick crossed. Worst case measured is ~127k, inside the
200,000 CU default. On a real validator a bare hooked transfer costs ~33–39k CU,
below the LiteSVM figures, so these are conservative.

We also removed an Anchor `bump` constraint that was running
`find_program_address` on chain on every transfer, and we grind the mint address
at launch so your derivation of the validation PDA resolves on the first bump.

## Mint configuration

Every mint-level authority is revoked at launch, verified by reading the mint
back from chain:

| Authority | State |
| --- | --- |
| Mint | Revoked — supply fixed at launch |
| Freeze | Never set |
| Transfer hook | Revoked — the hook can never be repointed |
| Metadata update | Revoked — name, symbol and image immutable |

The program upgrade authority is the one remaining centralised power; our plan
for it is described below.

## Things we think you will want to raise

- **LPs can only enter and exit during market hours.** Adding liquidity,
  removing it, and collecting fees are all transfers, so all three are blocked
  overnight and at weekends. We have tested this and accept it; we would want it
  communicated clearly to anyone providing liquidity.
- **Pool creation must happen during market hours**, since seeding liquidity is
  a transfer.
- **A pool that fails most of the time may look broken** in your UI or be
  deprioritised by routers. We would like your view on how this presents.
- **Self-transfers bypass the hook** — Token-2022 short-circuits them before the
  CPI. No value moves, but we mention it for completeness.
- **The hook trusts the cluster clock.** We measured mainnet drift at ~1 second,
  so the hook can disagree with the real bell by about that much, and only
  within seconds of 09:30 or 16:00.

## Questions for you

1. Is a hook that rejects by design, for the majority of the time, badgeable at
   all? This is the one that decides whether we proceed.
2. How does a pool that fails outside a fixed window present in the Orca UI and
   to routers?
3. Can a TokenBadge be revoked after issuance? We would like to understand the
   delisting risk before building on it.
4. Is the legacy `@orca-so/whirlpools-sdk` the supported path for hook
   integrations? The newer `@orca-so/whirlpools` does not attach TransferHook
   extra accounts on V2 instructions and fails with `0x17a2`
   (orca-so/whirlpools#1372).
5. Anything you would want changed in the hook before considering a badge?

## Status and what we are not claiming

The program is **unaudited** and currently deployed to devnet only. We are not
asking for a mainnet badge today — we want to know whether this is viable before
commissioning an audit, since the audit is the larger commitment.

Test coverage today: 14 Rust unit tests over the calendar logic (its session
table is generated from the IANA tz database, and a differential over 525,888
five-minute slots across 2026–2031 matches tzdata exactly), 33 integration tests
under LiteSVM with a controlled clock, 11 against your real program, plus a
real-validator check. Blocking behaviour is mutation-tested.

We have not tested aggregator routing on mainnet, and the program has never run
on mainnet.
