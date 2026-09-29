# NYSE Token Hook

A Token-2022 **transfer hook** that rejects transfers outside NYSE trading hours.
The program is stateless: on every transfer Token-2022 CPIs into it, and it
computes the current NYSE session from the on-chain `Clock` and either returns
`Ok` or an error that aborts the whole transaction.

**Status: unaudited. Deployed to devnet only. Not ready for mainnet** — see
[Before mainnet](#before-mainnet).

## Market calendar

Transfers are permitted Monday–Friday, 09:30–16:00 ET, except:

| Blocked | Detail |
| --- | --- |
| Weekends | Saturday and Sunday |
| Full closures | New Year's Day, MLK Day, Washington's Birthday, Good Friday, Memorial Day, Juneteenth, Independence Day, Labor Day, Thanksgiving, Christmas |
| Outside session | Before 09:30 ET, at or after 16:00 ET |

NYSE closes at 13:00 ET on a few days (July 3, the Friday after Thanksgiving,
Christmas Eve). This program **deliberately does not enforce those** — the
session is a uniform 09:30–16:00 on every trading day. The test suite pins that
choice so it cannot regress silently.

Holiday observance follows NYSE Rule 7.2: a holiday on Saturday moves to the
preceding Friday and one on Sunday to the following Monday, except New Year's
Day, which is not observed on the preceding December 31.

Eastern Time is computed from the post-2007 US DST rule (second Sunday in March
02:00 EST through the first Sunday in November 02:00 EDT). Dates use Howard
Hinnant's `days_from_civil`/`civil_from_days`, which are leap-year exact.

## Errors

| Code | Error | Meaning |
| --- | --- | --- |
| 6000 | `MarketClosedWeekend` | Saturday or Sunday |
| 6001 | `MarketClosedHoliday` | Exchange holiday |
| 6002 | `MarketClosedPreMarket` | Before 09:30 ET |
| 6003 | `MarketClosedAfterHours` | At or after 16:00 ET |
| 6004 | `NotTransferring` | `Execute` called outside a real transfer |
| 6005 | `InvalidTokenAccount` | Source account is not parseable Token-2022 state |
| 6006 | `UnsupportedInstruction` | Non-`Execute` transfer-hook instruction |

## Testing

```bash
cargo test -p nyse-token-hook
```

14 unit tests over the calendar logic. The market-state table is generated from
the IANA tz database rather than written by hand, so it is independent of the
code it checks:

```bash
python3 scripts/gen_market_table.py --check   # verify the DST rule against tzdata
python3 scripts/gen_market_table.py           # regenerate the table
```

```bash
anchor build && npx ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.ts'
```

25 integration tests that run the compiled program under LiteSVM with a
controlled clock, attempting real Token-2022 transfers at each market state and
asserting on the on-chain result and the token balances.

## Launching

Blocking transfers is only half the job. A mint whose authorities are still live
can be inflated, frozen, or have its hook repointed at a no-op program, so the
launch must close those doors permanently.

### 1. Build and deploy the program

```bash
anchor build
anchor deploy --provider.cluster devnet
```

### 2. Launch the mint

[scripts/launch-token.ts](scripts/launch-token.ts) creates the mint with on-chain
metadata, mints the entire supply once, and revokes every mint-level authority in
the process. It dry-runs by default:

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
is stored on the mint itself, so wallets, explorers and DEX aggregators resolve
it with no Metaplex account. `--uri` should point at a JSON file with at least
`name`, `symbol`, `description` and `image` — see
[stonks-metadata.json](stonks-metadata.json).

Revoking the transfer hook authority is not optional. The test suite includes a
mutation check showing that if it survives, the hook can be repointed at a no-op
program and the market-hours restriction disappears entirely.

### 3. Burn the program upgrade authority

The mint is locked, but the *program* can still be upgraded, which would let the
holder of that key rewrite the trading-hours rule for every token using the hook.
This is the last centralised power:

```bash
solana program set-upgrade-authority CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k --final
```

This is irreversible: bugs can never be patched afterwards. Audit first.

> [scripts/deploy-stonks-token.ts](scripts/deploy-stonks-token.ts) is the older
> devnet script. It leaves the mint and transfer-hook authorities live, so the
> token it produces is inflatable and the hook is removable. Use
> `launch-token.ts` for anything real.

### 3. Transferring

Wallets and programs must append the hook's accounts to `TransferChecked`. This
hook resolves zero extra accounts, so that is just the hook program ID followed
by the validation-state PDA — which is what
`createTransferCheckedWithTransferHookInstruction` produces.

## Venue support

This is the binding constraint, not the hook. A transfer hook can make a
transfer fail, so venues have to opt into supporting one — and most require it
to be *revoked*, which defeats the point.

```bash
npx ts-node scripts/check-mint-readiness.ts --cluster devnet --mint <MINT>
```

reads a mint and reports it against each venue's rules:

| Venue | Active transfer hook | Source |
| --- | --- | --- |
| **Orca Whirlpools** | **Supported, permanently — TokenBadge required** | `is_supported_token_mint` in `programs/whirlpool/src/util/v2/token.rs` returns `false` for `TransferHook` unless a TokenBadge is initialized |
| Meteora DBC | Runs during the bonding curve, then **revoked on completion** | "DBC revokes the transfer-hook program id and transfer-hook authority from the base mint when the curve completes" |
| Meteora DAMM v2 | Effectively no | `TransferHook` permissionless "only when both the hook program ID and hook authority are unset"; "DAMM v2 does not provide a general transfer-hook remaining-account surface for swaps, liquidity, fees, or rewards" |
| Meteora DLMM | Badge required, forwarding undocumented | `TransferHook`, "only when both the hook program and hook authority are revoked" |

**Orca is currently the only venue that keeps the hook alive permanently.** A
TokenBadge is a PDA that Orca controls, so listing is a permissioned step.

This is verified end to end against Orca's real mainnet Whirlpool program, not
by reading docs. [tests/orca-integration.ts](tests/orca-integration.ts) loads the
mainnet program binary and Orca's live `WhirlpoolsConfig` into LiteSVM (only the
config's authorities are repointed, so the test can issue itself a badge), then:

```bash
./scripts/fetch-orca-fixtures.sh   # pulls the program + config from mainnet
npm run test:orca
```

| Result | |
| --- | --- |
| `initializePoolV2` without a badge | rejected, `UnsupportedTokenMint` (6047) |
| `initializePoolV2` with a badge | pool created |
| `increaseLiquidityV2` in session | liquidity added, vault funded |
| `swapV2` in session | succeeds, ~92-101k CU for the whole swap |
| `swapV2` at 16:30 ET | rejected, our `MarketClosedAfterHours` (6003) |
| `swapV2` on Saturday | rejected, our `MarketClosedWeekend` (6000) |
| `swapV2` when the market reopens | succeeds again |

The blocked swaps fail with *our* hook's error codes propagating out through
Token-2022 into Whirlpool, so the restriction demonstrably survives a real AMM
swap path. Note the clock only moves forward in that test: Whirlpool rejects a
backwards clock with `InvalidTimestamp`.

Build Orca instructions with the legacy [`@orca-so/whirlpools-sdk`](https://www.npmjs.com/package/@orca-so/whirlpools-sdk),
which wires hook accounts via `RemainingAccountsBuilder` +
`TokenExtensionUtil.getExtraAccountMetasForTransferHook`. The newer
`@orca-so/whirlpools` does not attach them on V2 instructions yet and fails with
`0x17a2 NoExtraAccountsForTransferHook` — see
[orca-so/whirlpools#1372](https://github.com/orca-so/whirlpools/issues/1372).

**Meteora DBC cannot host a permanent restriction.** Completion is triggered by
the migration quote threshold and there is no option to disable it — the
migration options are DAMM v1/v2 only. Setting an unreachable threshold makes
graduation economically unlikely, not impossible, and if it ever completes the
hook is revoked permanently.

**Only transfers are gated.** Token-2022 invokes a transfer hook from
`Transfer`/`TransferChecked` and nowhere else. Burning, minting, and approving a
delegate are all unaffected by market hours — the integration suite asserts this
explicitly. Revoking the mint and freeze authorities at launch closes all of
these except burning.

**Burning can never be blocked.** Any holder can always burn their own tokens,
including while the market is closed, and no Token-2022 extension prevents it.
Supply is therefore fixed at launch and monotonically non-increasing, rather than
strictly constant. Burning is not a transfer, so it cannot be used to move value
or trade outside market hours.

**Exposure is transferable even when the token is not.** Anything that holds the
token and is itself a different mint — an LP position, a vault share, a wrapper —
has no hook on it and moves freely 24/7. The hook locks this mint, not the
economic exposure to it.

**Unscheduled closures are not modelled.** NYSE closes for national days of
mourning and severe weather with no fixed rule. The program will permit trading
on those days.

**The hook does not stop price discovery.** It blocks on-chain transfers of the
mint. It does not prevent off-chain trading, derivatives, or wrapped claims on
the token from being priced while the NYSE is closed.

**Time comes from the validator clock.** `Clock::unix_timestamp` is a
stake-weighted estimate, not an exact wall clock, and can drift from real time.
Transfers near the open and close may be decided a little early or late.

**Only the post-2007 DST rule is implemented.** If US DST law changes, the
program needs an upgrade. The same is true for changes to the NYSE calendar.

## Before mainnet

- [ ] Independent security audit. A bug in this program freezes holders' funds.
- [ ] Confirm the venues you intend to list on support arbitrary transfer hooks.
- [ ] Decide and document who controls the program upgrade authority. As
      deployed it is a single hot wallet, which means that key can change or
      disable the trading-hours rule for every token using the hook.
- [ ] Set the mint's transfer-hook authority to `None` at launch, or the hook
      can be repointed at a no-op program.
- [ ] Revoke mint authority if the supply is meant to be fixed.
