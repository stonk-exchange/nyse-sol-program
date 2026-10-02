#!/usr/bin/env bash
# Verify a deployed program byte-for-byte against the local build, and report
# its upgrade authority.
#
# Run this after `solana program deploy` and BEFORE burning the authority.
# A deploy can fail part-way and leave mismatched bytecode on chain; burning
# after that would make the broken version permanent.
#
#   ./scripts/verify-deployment.sh mainnet-beta
set -euo pipefail

CLUSTER="${1:-devnet}"
PROGRAM_ID="CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k"
LOCAL="target/deploy/nyse_token_hook.so"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -f "$LOCAL" ] || { echo "no local build at $LOCAL -- run 'anchor build'"; exit 1; }

echo "program  $PROGRAM_ID"
echo "cluster  $CLUSTER"
echo

solana program dump "$PROGRAM_ID" "$TMP/onchain.so" --url "$CLUSTER" >/dev/null

# A dump is zero-padded up to the allocated size, so compare only the prefix.
LOCAL_SIZE=$(wc -c < "$LOCAL" | tr -d ' ')
head -c "$LOCAL_SIZE" "$TMP/onchain.so" > "$TMP/trimmed.so"

LOCAL_HASH=$(shasum -a 256 "$LOCAL" | awk '{print $1}')
CHAIN_HASH=$(shasum -a 256 "$TMP/trimmed.so" | awk '{print $1}')

echo "local  sha256  $LOCAL_HASH"
echo "chain  sha256  $CHAIN_HASH"
echo

if [ "$LOCAL_HASH" != "$CHAIN_HASH" ]; then
  echo "MISMATCH -- the deployed program is not your local build."
  echo "Do NOT burn the upgrade authority. Redeploy first."
  exit 1
fi
echo "bytecode matches."

AUTH=$(solana program show "$PROGRAM_ID" --url "$CLUSTER" | awk '/Authority:/ {print $2}')
echo "upgrade authority: ${AUTH:-none}"
echo
if [ "${AUTH:-none}" = "none" ]; then
  echo "Already immutable. Nothing further to do."
else
  echo "Still upgradeable. To make it permanent and irreversible:"
  echo
  echo "  solana program set-upgrade-authority $PROGRAM_ID --final \\"
  echo "    --keypair usb://ledger --url $CLUSTER"
  echo
  echo "After this there is no way to patch a bug in this program. Any fix"
  echo "would need a new program id, and tokens already launched would stay"
  echo "pointed at this one."
fi
