#!/usr/bin/env bash
# Fetch the mainnet Orca Whirlpool program and config accounts used by
# tests/orca-integration.ts. Fixtures are gitignored; re-run to refresh.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/fixtures/orca"
WHIRLPOOL="whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
CONFIG="2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ"
RPC="${SOLANA_RPC:-https://api.mainnet-beta.solana.com}"

mkdir -p "$DIR"
echo "fetching Whirlpool program..."
solana program dump "$WHIRLPOOL" "$DIR/whirlpool.so" --url "$RPC"

echo "fetching config accounts..."
npx ts-node -e "
const { Connection, PublicKey } = require('@solana/web3.js');
const { PDAUtil, ORCA_WHIRLPOOL_PROGRAM_ID } = require('@orca-so/whirlpools-sdk');
const fs = require('fs');
(async () => {
  const c = new Connection('$RPC', 'confirmed');
  const cfg = new PublicKey('$CONFIG');
  const grab = async (pk) => {
    const a = await c.getAccountInfo(pk);
    if (!a) throw new Error('missing account ' + pk.toBase58());
    return { pk: pk.toBase58(), data: a.data.toString('base64'), owner: a.owner.toBase58(), lamports: a.lamports };
  };
  const out = {
    config: await grab(cfg),
    ext: await grab(PDAUtil.getConfigExtension(ORCA_WHIRLPOOL_PROGRAM_ID, cfg).publicKey),
    feeTier: await grab(PDAUtil.getFeeTier(ORCA_WHIRLPOOL_PROGRAM_ID, cfg, 64).publicKey),
  };
  fs.writeFileSync('$DIR/config.json', JSON.stringify(out, null, 2) + '\n');
  console.log('wrote $DIR/config.json');
})();
"
echo "done. run: npm run test:orca"
