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

### DBC configs

A config's `feeClaimer` is set at creation and **no instruction anywhere in DBC
can change it**. The migration threshold is what keeps the hours permanent: DBC
strips the transfer hook when a curve completes, so the threshold is set out of
reach.

| config | quote | tier | opening FDV | threshold | status |
| --- | --- | --- | --- | --- | --- |
| `77aqJUCTs6anDL9ypRT6zDh6Y9o8zKQ5ALvXb1JF2SAR` | SOL | 1% creator | 30 SOL | 100,000 SOL | **current** |
| `Dh7vBs5PoqqmyduMfEy6bS8K2Z4o8t59jLcpZQUToCSf` | SOL | 1% creator | 31,250 SOL | 100,000 SOL | superseded — see below |

Both have `feeClaimer` = `FTnprQrx…`, 250 bps total (1.00% creator, 1.00%
platform, 0.50% Meteora), LP 50/0/50/0 all permanently locked.

The superseded config opens about a thousand times too high. Its curve was
derived from a supply percentage rather than a target market cap, which at a
100,000 SOL threshold forces a very high opening price. The current config
copies its price curve from hours.fun's equivalent via `--curve-from`, giving
the same 30 SOL open and the same 100,000 SOL threshold. A config's curve cannot
be changed, so the fix was a new config.

Reference curve source: `EzzRR1fmvQjkgCnTW7RiVDSBcmK2isEZZyQheBvDeGg9`.

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
