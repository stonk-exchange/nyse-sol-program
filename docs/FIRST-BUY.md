# First buy

Whether the launcher can take the opening price before anyone else, what
hours.fun actually does, and what it would cost us to do better.

## The constraint

A buy is a transfer, so it invokes the hook, so **a first buy only works while
the market is open**. Launch at 20:00 ET and there is no first buy until 09:30
the next session. If the buy were atomic with the launch, an out-of-hours launch
would fail outright rather than launching without a buy.

This is not avoidable. It is the hook doing its job.

## What hours.fun does

Their UI offers a FIRST BUY field, captioned "Your hours are open right now, so
this buy goes through at launch". On chain it is an ordinary swap in a second
transaction, signed by the creator, not part of the launch.

Surveyed across their 100 live tokens, reading each token's genuinely oldest
transaction (paging back past the 1000-signature window, which otherwise returns
a later trade and looks like a first buy):

```
creation tx containing a first buy :  0 / 99
```

And of the first 20 where a first trade exists, who got there first:

```
first trade by the creator  :  5 / 20
first trade by someone else : 15 / 20
median gap to the first trade: 17s
fastest observed sniper      :  1s
```

So the feature exists, it is a regular buy, and **three times in four a bot beat
the creator to it**. "Goes through at launch" means "fires right after".

## Why we cannot simply copy it into one transaction

Their hook's initialize instruction is 42 bytes. Ours is 450, because ours
carries a 207-entry holiday table and theirs carries no holidays at all — their
hook accounts are 10 to 58 bytes, far too small for one. They enforce weekday,
hours and DST; we also enforce holidays.

That 408-byte difference is the whole story. Measured:

| | bytes | |
| --- | --- | --- |
| our launch, legacy | 1286 | over the 1232 limit |
| our launch, v0 + lookup table | 1096 | fits, 136 spare |
| our launch + first buy, v0 + lookup table | >1232 | will not serialize |

The first buy adds five instructions (two ATA creations, a wSOL wrap, the swap
with 19 accounts, a close). There is no room.

## Options

### A. Two transactions

Launch, then buy. Works today with `scripts/trade.ts`; no new code.

This is what hours.fun does, and the numbers above are what it gets you. With a
Ledger approving twice the gap is tens of seconds, which on this evidence loses
most of the time.

### B. Hot wallet fires immediately

Pre-sign a buy from the hot wallet and submit the moment the launch confirms.
Narrows the gap from tens of seconds to roughly one block. Tokens land on a hot
key and have to be swept to the Ledger afterwards, during market hours.

Better than hours.fun in practice, still not a guarantee.

### C. Jito bundle

Launch and buy as two transactions submitted as an atomic bundle: same block, in
order, or neither lands. No program change, nothing added to the transfer path,
nothing that has to survive the upgrade-authority burn.

**Genuinely first.** The buy is in the same block as the pool's creation, so
there is no slot to front-run.

Costs: a Jito dependency, a tip on top of fees, the Ledger signing both
transactions before either is submitted, and a retry path for when a bundle is
not selected.

### D. Shrink the schedule (program change)

Move the holiday table out of the per-token schedule into a shared `Calendar`
PDA at `["calendar", hash]`, written once by the registry authority and
immutable. The per-token `Schedule` drops from 482 bytes to about 48 — the mint
and the hash. `initialize` then carries 32 bytes instead of 450, the launch
falls to roughly 700 bytes, and the first buy fits in one transaction.

What changes:

- a `Calendar` account, and `register_calendar` to write it
- `initialize` takes a hash instead of the full schedule
- `transfer_hook` reads Schedule then Calendar, so `ExtraAccountMetaList` grows
  to two entries with the calendar derived through `Seed::AccountData`
- **the hook must read both layouts forever**, because three live tokens carry
  the old 482-byte schedule
- redeploy (~2.34 SOL, one Ledger approval), and re-run every test

Side benefits independent of the first buy: 482 bytes less rent per token, and
far more headroom for calendars with longer holiday tables.

Risks: the dual-format read sits in the code that runs on every transfer of
every token, and `Seed::AccountData` is a less-travelled path in the
transfer-hook interface. Both become permanent on burn.

**This must land before the upgrade authority is burned.** Afterwards it needs a
new program id, and tokens already launched stay pointed at the old one.

## Recommendation

**C, the Jito bundle.** It achieves the actual goal — first, reliably, which
hours.fun fails at three times in four — without putting permanent dual-format
logic into the hottest path in the program.

D is worth doing only if the schedule shrink is wanted for its own sake. In that
case it has to be decided before the burn, not after.
