# NYSE Token Hook

A Token-2022 **transfer hook** that restricts a mint's transfers to NYSE trading
hours. Token-2022 calls into the program on every transfer; it derives the
current NYSE session from the on-chain `Clock` and either returns `Ok` or an
error that aborts the entire transaction.

The program is stateless — no config account, no admin instructions, nothing to
tune after deployment.

> **Status: unaudited.** Deployed to devnet only. See
> [Before mainnet](#before-mainnet).

---

## Market calendar

Transfers are permitted **Monday–Friday, 09:30–16:00 ET**. Everything else is
blocked:

| Blocked | Detail |
| --- | --- |
| Weekends | Saturday and Sunday |
| Exchange holidays | New Year's Day, MLK Day, Washington's Birthday, Good Friday, Memorial Day, Juneteenth, Independence Day, Labor Day, Thanksgiving, Christmas |
| Outside session | Before 09:30 ET, at or after 16:00 ET |

Holiday observance follows NYSE Rule 7.2: a holiday falling on a Saturday moves
to the preceding Friday, one on a Sunday to the following Monday — except New
Year's Day, which is not observed on the preceding December 31.

Eastern Time comes from the post-2007 US DST rule (second Sunday in March 02:00
EST through the first Sunday in November 02:00 EDT). Dates use Howard Hinnant's
`days_from_civil` / `civil_from_days`, which are leap-year exact.

**Half-days are deliberately not enforced.** NYSE closes at 13:00 ET on July 3,
the Friday after Thanksgiving, and Christmas Eve. This program trades a full
session on those days so holders are never surprised by an early close. The test
suite pins that choice.

### Errors

| Code | Error | Meaning |
| --- | --- | --- |
| 6000 | `MarketClosedWeekend` | Saturday or Sunday |
| 6001 | `MarketClosedHoliday` | Exchange holiday |
| 6002 | `MarketClosedPreMarket` | Before 09:30 ET |
| 6003 | `MarketClosedAfterHours` | At or after 16:00 ET |
| 6004 | `NotTransferring` | `Execute` called outside a real transfer |
| 6005 | `InvalidTokenAccount` | Source account is not parseable Token-2022 state |
| 6006 | `UnsupportedInstruction` | Non-`Execute` transfer-hook instruction |

---

## Repository layout

```
programs/nyse-token-hook/src/
  lib.rs                  the program: calendar logic and the hook itself
  market_tests.rs         unit tests; the session table is generated, not hand-written
scripts/
  launch-token.ts         create a locked-down, NYSE-restricted mint
  check-mint-readiness.ts read a mint and report per-venue listing readiness
  gen_market_table.py     regenerate the test table from the IANA tz database
  fetch-orca-fixtures.sh  pull Orca's mainnet program + config for the Orca test
tests/
  nyse-token-hook.ts      LiteSVM integration tests with a controlled clock
  orca-integration.ts     end-to-end against Orca's real mainnet Whirlpool program
metadata-example.json     template for the --uri metadata JSON
```

---

## Testing

```bash
npm test          # Rust unit tests + LiteSVM integration tests
npm run test:unit
npm run test:integration
```

**14 Rust unit tests** over the calendar logic. The session table is generated
from the IANA tz database rather than written by hand, so it is independent of
the code it checks:

```bash
npm run check:tzdata   # verify the hardcoded DST rule against tzdata
npm run gen:table      # regenerate the table
```

A differential of the implementation against tzdata over 525,888 five-minute
slots spanning 2026–2031 matches exactly.

**25 integration tests** running the compiled program under LiteSVM with a
controlled clock. They attempt real Token-2022 transfers at each market state
and assert on the on-chain error code and token balances, plus cover the
launch configuration (fixed supply, immutable hook, immutable metadata).

### Against Orca's real program

```bash
npm run fetch:orca    # pull the mainnet program + config (gitignored)
npm run test:orca
```

Loads Orca's mainnet Whirlpool binary and live `WhirlpoolsConfig` into LiteSVM.
Only the config's authorities are repointed, so the test can issue itself a
TokenBadge; Orca's program is untouched.

| Step | Result |
| --- | --- |
| `initializePoolV2` without a badge | rejected, `UnsupportedTokenMint` (6047) |
| `initializePoolV2` with a badge | pool created |
| `increaseLiquidityV2` in session | liquidity added, vault funded |
| `swapV2` in session | succeeds, ~92–101k CU for the whole swap |
| `swapV2` at 16:30 ET | rejected, `MarketClosedAfterHours` (6003) |
| `swapV2` on a Saturday | rejected, `MarketClosedWeekend` (6000) |
| `swapV2` when the market reopens | succeeds again |

The blocked swaps fail with *this program's* error codes propagating out through
Token-2022 into Whirlpool, so the restriction holds through a real AMM swap path.

Note: Whirlpool rejects a clock that moves backwards with `InvalidTimestamp`, so
the test's scenarios are ordered strictly forward in time.

### Compute budget

```bash
npm run bench   # needs the Orca fixtures
```

Builds two identical Orca pools -- one hooked, one not -- and runs the same
operations on both, so the delta is the hook's marginal cost.

| Operation | No hook | With hook | Delta |
| --- | ---: | ---: | ---: |
| `increaseLiquidityV2` | ~23k | ~60k | +37k |
| `swapV2`, within one tick array | ~48k | ~96k | +48k |
| `swapV2`, crossing ~3 tick arrays | ~73k | ~121k | +48k |
| `twoHopSwapV2` (aggregator-style route) | ~82k | ~127k | +45k |

The hook costs a roughly constant ~40-50k CU regardless of swap size, because
it runs once per transfer rather than once per tick crossed. Worst case measured
is ~127k, comfortably inside the 200,000 CU default transaction budget.

**The mint address affects this.** Token-2022 derives the validation PDA with
`find_program_address` on every transfer, and each bump iteration it has to try
costs ~1,500 CU. A mint whose canonical bump is 255 resolves first try; one with
bump 248 pays an extra ~10,500 CU on every transfer for the life of the token.
`launch-token.ts` grinds for bump 255, which is nearly free since roughly half of
all keypairs qualify. `scripts/probe-bump-cost.ts` measures the relationship.

---

## Launching

Blocking transfers is only half the job. A mint whose authorities are still live
can be inflated, frozen, or have its hook repointed at a no-op program — which
removes the restriction entirely. The launch must close those doors permanently.

### 1. Build and deploy the program

```bash
anchor build
anchor deploy --provider.cluster devnet
```

### 2. Launch the mint

[`scripts/launch-token.ts`](scripts/launch-token.ts) creates the mint with
on-chain metadata, mints the entire supply once, and revokes every mint-level
authority in the same transaction. It dry-runs by default:

```bash
ANCHOR_WALLET=~/.config/solana/id.json npx ts-node scripts/launch-token.ts \
  --cluster devnet --name "STONKS" --symbol STONKS \
  --uri https://example.com/metadata.json --supply 1000000 --decimals 9
```

Add `--execute` to send. Afterwards it reads the mint back from chain and
verifies:

| Check | Result |
| --- | --- |
| Supply | Exactly the requested amount |
| Mint authority | Revoked — supply can never increase |
| Freeze authority | Never set — no one can freeze or thaw a holder |
| Transfer hook | Still points at this program |
| Transfer hook authority | Revoked — the hook can never be repointed |
| Metadata | Name, symbol and uri readable on-chain |
| Metadata update authority | Revoked — name/symbol/image are immutable |

Metadata uses the Token-2022 `MetadataPointer` + `TokenMetadata` extensions and
lives on the mint itself, so wallets, explorers and DEX aggregators resolve it
with no Metaplex account. Point `--uri` at a JSON file shaped like
[`metadata-example.json`](metadata-example.json).

Revoking the transfer hook authority is **not optional**. The test suite includes
a mutation check showing that if it survives, the hook can be repointed at a
no-op program and the market-hours restriction disappears entirely.

### 3. Burn the program upgrade authority

The mint is locked, but the *program* can still be upgraded, which would let the
holder of that key rewrite the trading-hours rule for every token using the hook.
This is the last centralised power:

```bash
solana program set-upgrade-authority <PROGRAM_ID> --final
```

Irreversible — bugs can never be patched afterwards. Audit first.

### 4. Check readiness

```bash
npm run check:mint -- --cluster devnet --mint <MINT>
```

Reads the mint and reports its configuration plus a per-venue verdict.

---

## Venue support

This is the binding constraint, not the hook. A transfer hook can make a
transfer fail, so venues must opt into supporting one — and most require it to be
*revoked*, which defeats the point.

| Venue | Active transfer hook | Source |
| --- | --- | --- |
| **Orca Whirlpools** | **Supported permanently — TokenBadge required** | `is_supported_token_mint` in `programs/whirlpool/src/util/v2/token.rs` returns `false` for `TransferHook` unless a TokenBadge is initialized |
| Meteora DBC | Runs during the bonding curve, then **revoked on completion** | "DBC revokes the transfer-hook program id and transfer-hook authority from the base mint when the curve completes" |
| Meteora DAMM v2 | Effectively no | Permissionless "only when both the hook program ID and hook authority are unset"; "DAMM v2 does not provide a general transfer-hook remaining-account surface for swaps, liquidity, fees, or rewards" |
| Meteora DLMM | Badge required, forwarding undocumented | Permissionless "only when both the hook program and hook authority are revoked" |

**Orca is currently the only venue that keeps the hook alive permanently.** A
TokenBadge is a PDA that Orca controls, so listing is a permissioned step —
request review via the Support function in the Orca app wallet menu, or via
Discord/Telegram. Review is case by case.

Build Orca instructions with the legacy
[`@orca-so/whirlpools-sdk`](https://www.npmjs.com/package/@orca-so/whirlpools-sdk),
which wires hook accounts via `RemainingAccountsBuilder` +
`TokenExtensionUtil.getExtraAccountMetasForTransferHook`. The newer
`@orca-so/whirlpools` does not attach them on V2 instructions and fails with
`0x17a2 NoExtraAccountsForTransferHook` — see
[orca-so/whirlpools#1372](https://github.com/orca-so/whirlpools/issues/1372).

**Meteora DBC cannot host a permanent restriction.** Completion is triggered by
the migration quote threshold and there is no option to disable it — the
migration options are DAMM v1/v2 only. An unreachable threshold makes graduation
economically unlikely, not impossible, and completion revokes the hook forever.

---

## Limitations

**Only transfers are gated.** Token-2022 invokes a transfer hook from
`Transfer`/`TransferChecked` and nowhere else. Burning, minting and approving a
delegate are unaffected by market hours — the integration suite asserts this
explicitly. Revoking the mint and freeze authorities at launch closes all of
these except burning.

**Burning can never be blocked.** Any holder can always burn their own tokens,
including while the market is closed, and no Token-2022 extension prevents it.
Supply is therefore fixed at launch and monotonically non-increasing rather than
strictly constant. Burning is not a transfer, so it cannot move value or be used
to trade outside market hours.

**Exposure is transferable even when the token is not.** Anything holding the
token that is itself a different mint — an LP position, a vault share, a wrapper
— has no hook on it and moves freely 24/7. The hook locks this mint, not the
economic exposure to it.

**Liquidity can only move during market hours.** Adding or removing liquidity is
a transfer, so pools can only be created, funded or drained while the market is
open. LPs are locked in overnight and over weekends.

**Unscheduled closures are not modelled.** NYSE closes for national days of
mourning and severe weather with no fixed rule. The program will permit trading
on those days.

**Time comes from the validator clock.** `Clock::unix_timestamp` is a
stake-weighted estimate, not an exact wall clock, and can drift from real time.
Transfers near the open and close may be decided slightly early or late.

**Only the post-2007 DST rule is implemented.** If US DST law or the NYSE
calendar changes, the program needs an upgrade — which conflicts with burning the
upgrade authority. Decide deliberately which risk you prefer.

---

## Before mainnet

- [ ] Independent security audit. A bug in this program freezes holders' funds.
- [ ] Confirm Orca will issue a TokenBadge. The hook rejects transfers by design
      for roughly 81% of wall-clock time, which is unlike any hook they have
      badged; get an informal read before preparing a full submission.
- [ ] Decide whether to burn the program upgrade authority, and document who
      holds it until then.
- [ ] Launch with `launch-token.ts` so every mint-level authority is revoked.
- [ ] Verify the live mint with `check-mint-readiness.ts` before distributing it.
