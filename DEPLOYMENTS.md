# Deployments

Live addresses, and what is permanent about each. Everything here was read back
from chain after it was created, not copied from the output that created it.

## Solana mainnet-beta

### Hook program

| | |
| --- | --- |
| program | `CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k` |
| programdata | `HmVv7yHS5vgWfj1xm8C9hY8ASvTGBcG4Hi9nhgRfRJw2` |
| bytecode sha256 | `c4d83f2f35410843a99edcaf2144052298c95bf386058115b91948771eb2d2ba` |
| upgrade authority | `FTnprQrxXRGBAJRg8axCbocBNeSvQC3YoCFqEE8khJ3c` (Ledger) |
| rent | 1.70280076 SOL |

Deployed with `scripts/deploy-ledger.sh`: a hot wallet uploads the buffer, the
Ledger signs only the deploy itself, and the bytecode is compared against the
local build both in the buffer and on chain.

**Not yet burned.** While an upgrade authority exists, the trading-hours
guarantee is only as strong as that device. Burning is what makes it credible,
and the registry below means burning costs nothing in future flexibility:

```
./scripts/verify-deployment.sh mainnet-beta   # confirm bytecode first
solana program set-upgrade-authority CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k --final \
  --keypair ~/.config/solana/nyse-deploy-hot.json \
  --upgrade-authority usb://ledger?key=0 --url mainnet-beta
```

### Market registry

| | |
| --- | --- |
| registry | `4bSTYZUEfk9efPSoWZqbWK4VKgnf3k54QcpfJW2cqTvh` |
| authority | `FTnprQrxXRGBAJRg8axCbocBNeSvQC3YoCFqEE8khJ3c` (Ledger) |

Created by `REGISTRY_BOOTSTRAP`, which is compiled into the program and can
never run again. The authority may approve new calendars with
`launch-dbc.ts register-market`; a calendar is data, so adding one needs no
program upgrade. Approving or revoking affects only future launches — a token
copies its schedule into its own account at launch and nothing can reach it
afterwards.

### Calendars

| market | hours | holiday horizon | how it is approved |
| --- | --- | --- | --- |
| `nyse` | 09:30–16:00 ET, Mon–Fri | **2046** | compiled into the program |
| `sse` | 09:15–11:30 and 13:00–15:30 CST, Mon–Fri | **2026-12-31** | registry, PDA `BF2GHyuNAETacfgE749pSWvKxi9CWdLwP7ifB4uN3rCj` |

SSE's schedule hash is `273e630e59028ffbba085b253f0b74129ac05dd98e831f8188d9944d2a432304`,
and the stored hash on chain was read back and matches.

SSE is the first calendar added through the registry rather than compiled in,
which is the proof that the registry works: a new market needs no program
upgrade and no new hook address.

Its hours were read off the ShanghaiWindowOracle on Robinhood Chain 4663
(`0x6384667531907bfe70EC7621eD67855881076F11`) by forking that chain and
stepping `block.timestamp` a minute at a time. The 09:15 open and the lunch
break match it. **The close does not**: that oracle shuts at 15:50, which is no
SSE boundary, so 15:30 — the end of after-hours fixed-price trading — was used
instead. Between 15:30 and 15:50 the two chains disagree, Solana shut and EVM
open.

**SSE's holiday table ends 2026-12-31.** Chinese market holidays are announced
annually and follow the lunar calendar, so they cannot be extrapolated the way
NYSE's can. Past that date an SSE token still enforces weekends and both
sessions but stops blocking holidays, and a token copies its schedule at launch.
Extending it for FUTURE tokens means registering a new calendar. Extending it
for tokens already live needs an `append_holidays` instruction, which does not
exist yet and would require the upgrade authority — so do not burn before
deciding.

### DBC configs

A config's `feeClaimer` is set at creation and **no instruction anywhere in DBC
can change it**. The migration threshold is what keeps the hours permanent: DBC
strips the transfer hook when a curve completes, so the threshold is set out of
reach.

| config | quote | tier | opening FDV | threshold | status |
| --- | --- | --- | --- | --- | --- |
| `77aqJUCTs6anDL9ypRT6zDh6Y9o8zKQ5ALvXb1JF2SAR` | SOL | 1% creator | 30 SOL | 100,000 SOL | **current** |
| `3mnEyRQ5JSa6EQNffSrKTC9TpaCri1zKm7BY7tGCw6g3` | USDC | 1% creator | 3,500 USDC | 12,000,000 USDC | **current** |
| `Dh7vBs5PoqqmyduMfEy6bS8K2Z4o8t59jLcpZQUToCSf` | SOL | 1% creator | 31,250 SOL | 100,000 SOL | superseded — see below |

The USDC config matches the SOL one's economics at the SOL price when it was
created ($116.91): 30 SOL is about $3,500, and 100,000 SOL about $11.7m, so the
threshold was set at $12m. It is arguably the sturdier of the two, because a
threshold denominated in USDC does not move with the SOL price — 100,000 SOL
would be roughly $6m if SOL halved.

There is no instruction anywhere in DBC that can change a config, and a pool
reads its config's threshold rather than storing its own, so a launched token's
graduation point is fixed for good. Raising it for future tokens means a new
config, which is cheap; existing tokens keep theirs.

Both have `feeClaimer` = `FTnprQrx…`, 250 bps total (1.00% creator, 1.00%
platform, 0.50% Meteora), LP 50/0/50/0 all permanently locked.

The superseded config opens about a thousand times too high. Its curve was
derived from a supply percentage rather than a target market cap, which at a
100,000 SOL threshold forces a very high opening price. The current config
copies its price curve from hours.fun's equivalent via `--curve-from`, giving
the same 30 SOL open and the same 100,000 SOL threshold. A config's curve cannot
be changed, so the fix was a new config.

Reference curve source for the SOL config: `EzzRR1fmvQjkgCnTW7RiVDSBcmK2isEZZyQheBvDeGg9`.

The USDC config needed no reference. `--open-fdv` solves the curve directly:
`buildCurveWithCustomSqrtPrices` derives the threshold from the two prices, so
the end price is bisected until the threshold lands where asked. No USDC
reference existed to copy — of the 100 USDC-quoted hooked configs on mainnet,
none match our token shape. Solving for 30 SOL and 100,000 SOL reproduces the
hours.fun economics exactly, which is how the solver was checked.

Fork-tested before deployment: config, lookup table and a single-transaction
launch on a local chain, then buy and sell during hours, fees accruing and
claiming in USDC, and a buy outside hours blocked with MarketClosed (6000).

### Launch lookup table

| | |
| --- | --- |
| table | for config | addresses |
| --- | --- | --- |
| `DXS76SxHNj1GvP4nXBsjZ5sXq9x8Te4Zn9T7NPSkiMrm` | `77aqJUCTs…` (SOL) | 9 |
| `6DuFvXr6ypGKuhkZ7szBmCuq6a62Jb6uk6ouFySnMwmh` | `3mnEyRQ5J…` (USDC) | 9 |

Both have authority `2WE8bqGTXQVsv1w8BM3Htqg9MQmLKKcfKrQoWubbJLRf` (hot wallet).

Without it a launch is two transactions, because the pool creation and the
schedule write come to 1286 bytes together and the limit is 1232. That split
leaves the token unusable if the second fails -- Token-2022 rejects every
transfer when the hook's validation state is missing -- and leaves a window in
which anyone can call `initialize` and pick the calendar.

Most of the overflow is account keys. Nine of them are the same for every
launch, so referencing them through this table brings the pair to 1105 bytes
and both halves land together. Tied to the config above, since the config and
its quote mint are among the nine; a new config needs its own table.

Confirmed on a local chain with the Ledger: it signs versioned (v0)
transactions, and the resulting mint is identical to the two-transaction path.

### Tokens

| mint | symbol | pool | config | note |
| --- | --- | --- | --- | --- |
| `7aFKpgvTRNZLmGRBnAsyqyYzFEzs2919vaWz2Wdhkh1i` | OPEN | `6W5tfLEXAcpoYJTeo7dLaXuoSEgr5HPGPs9KJQU6SABF` | current | correctly priced |
| `8giA1eZdjymZ36nB9GxzJhUayictKskgscKj3WuGHmxc` | STONKSOL | `HM39e16U2ZuyGW9tP18eVzyhFJ5Nmtd9qQ9P7GAK24v7` | superseded | opened at ~$3.7m |

Both: name `stonkonsol`, 1,000,000,000 supply at 6 decimals, NYSE 09:30–16:00 ET
Mon–Fri, metadata at `https://cdn.stonk.market/metadata/SOLANA/stonkonsol.json`.

Verified on chain for each: mint authority none, freeze authority none, metadata
update authority none, transfer hook set to the program above, and the hook's
validation state present (without it the token cannot be transferred at all).

The transfer hook's own authority is `FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM`,
which is Meteora's DBC pool authority PDA — no key exists for it. That is how
DBC revokes the hook at graduation, which is why the threshold is unreachable.
hours.fun's tokens carry the same authority; it is inherent to launching
through DBC.

### Wallets

| | |
| --- | --- |
| Ledger | `FTnprQrxXRGBAJRg8axCbocBNeSvQC3YoCFqEE8khJ3c` |
| deploy hot wallet | `2WE8bqGTXQVsv1w8BM3Htqg9MQmLKKcfKrQoWubbJLRf` |

The Ledger is the registry authority, the upgrade authority, the fee claimer on
every config and the pool creator on every token. The hot wallet only ever
uploads program buffers and pays transaction fees; its key is at
`~/.config/solana/nyse-deploy-hot.json`, outside this repository.

### Launching another token

One command, one transaction, one approval on the device:

```
ANCHOR_WALLET=~/.config/solana/nyse-deploy-hot.json \
npx tsx scripts/launch-dbc.ts token --cluster mainnet-beta \
  --config 77aqJUCTs6anDL9ypRT6zDh6Y9o8zKQ5ALvXb1JF2SAR \
  --lut DXS76SxHNj1GvP4nXBsjZ5sXq9x8Te4Zn9T7NPSkiMrm \
  --name "<NAME>" --symbol "<SYMBOL>" --uri <METADATA URL> \
  --market nyse --ledger --execute
```

Drop `--execute` to dry run. Name, symbol and schedule are frozen at launch.
Costs about 0.017 SOL, paid by the Ledger since `--ledger` makes it the signer.

Drop `--lut` to fall back to the two-transaction path.

### Claiming

Fees accrue in the **quote** token (`collectFeeMode = 0`), so a SOL-paired pool
pays in SOL and a stock-paired pool pays in that stock. The partner and creator
pots are separate instructions with separate signers, so each is its own
approval:

```
npx tsx scripts/launch-dbc.ts claim --cluster mainnet-beta \
  --pool <POOL> --as partner --ledger --execute
npx tsx scripts/launch-dbc.ts claim --cluster mainnet-beta \
  --pool <POOL> --as creator --ledger --execute
```

Claiming works while the market is closed — fees are quote-side and the hook
does not gate them.

### Operational notes

- The Solana Ledger app needs **blind signing enabled**; a program deploy is not
  a transfer, so the app cannot render it and refuses with "Ledger operation not
  supported".
- The device auto-locks between steps. Expect to unlock it repeatedly.
- `usb://ledger?key=0` is `44'/501'/0'`, **three** levels. The four-level
  `44'/501'/0'/0'` is a different account on the same device.
- Launch receipts (`dbc-config-*.json`, `dbc-token-*.json`) are gitignored; this
  file is the record.
