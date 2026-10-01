#!/usr/bin/env bash
# Fetch the mainnet Meteora DBC and DAMM v2 programs for scripts/dbc-test-harness.ts.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/fixtures/dbc"
RPC="${SOLANA_RPC:-https://api.mainnet-beta.solana.com}"
mkdir -p "$DIR"
solana program dump dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN "$DIR/dbc.so" --url "$RPC"
solana program dump cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG "$DIR/dammv2.so" --url "$RPC"
echo "done -> $DIR"
