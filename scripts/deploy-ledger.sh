#!/usr/bin/env bash
#
# Deploy the hook with a Ledger as upgrade authority, then make it immutable.
#
# WHY THIS IS STAGED
#
# A 335 KB program is written to chain in a few hundred transactions. Signing
# every one of them on a hardware wallet is not realistic, so the usual advice
# is to deploy from a hot wallet -- which means a key on disk briefly controls
# the program, and anyone who has that key can replace the bytecode.
#
# This script splits the job instead. The hot wallet uploads the bytes into a
# buffer account, which is inert: a buffer cannot execute, and nothing points at
# it. Control is then handed to the Ledger, and the Ledger alone authorises the
# two steps that matter:
#
#   press 1   turn the buffer into the live program
#   press 2   burn the upgrade authority
#
# The hot wallet never holds authority over a live program. If it is
# compromised at any point, the worst it can do is waste the buffer rent.
#
# Between upload and press 1 the buffer is compared byte-for-byte against the
# local build, and again after the deploy, before the authority is burned. A
# partial upload that went unnoticed would otherwise become permanent.
#
# USAGE
#   ./scripts/deploy-ledger.sh                      # dry run, prints the plan
#   ./scripts/deploy-ledger.sh --execute            # devnet
#   ./scripts/deploy-ledger.sh --execute --cluster mainnet-beta
#
# Each stage is skipped if it is already done, so a failure part-way through can
# be resumed by re-running the same command.
#
set -euo pipefail

CLUSTER="devnet"
EXECUTE=0
LEDGER_URL="usb://ledger?key=0"
EXPECT_LEDGER="FTnprQrxXRGBAJRg8axCbocBNeSvQC3YoCFqEE8khJ3c"
BURN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1; shift ;;
    --cluster) CLUSTER="$2"; shift 2 ;;
    --ledger-url) LEDGER_URL="$2"; shift 2 ;;
    --expect) EXPECT_LEDGER="$2"; shift 2 ;;
    --no-burn) BURN=0; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROGRAM_ID="CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k"
SO="target/deploy/nyse_token_hook.so"
PROGRAM_KEYPAIR="target/deploy/nyse_token_hook-keypair.json"
# The cluster may be a URL, so slugify it for the filename.
CLUSTER_SLUG="$(printf '%s' "$CLUSTER" | tr -c 'A-Za-z0-9._-' '_')"
STATE="target/deploy/.ledger-deploy-${CLUSTER_SLUG}.buffer"

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight --

step "preflight"

[ -f "$SO" ] || die "no build at $SO -- run 'anchor build'"
[ -f "$PROGRAM_KEYPAIR" ] || die "no program keypair at $PROGRAM_KEYPAIR"

# The keypair that creates the program account decides its address. If it does
# not match declare_id!, the program deploys to an address the code does not
# believe it lives at, and every PDA the hook derives is wrong.
KP_ID="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
DECLARED="$(grep -o 'declare_id!("[^"]*")' programs/nyse-token-hook/src/lib.rs | sed 's/.*("\(.*\)")/\1/')"
[ "$KP_ID" = "$PROGRAM_ID" ] || die "program keypair is $KP_ID, expected $PROGRAM_ID"
[ "$DECLARED" = "$PROGRAM_ID" ] || die "declare_id! is $DECLARED, expected $PROGRAM_ID"
say "program id          $PROGRAM_ID (keypair and declare_id! agree)"

SO_SIZE="$(wc -c < "$SO" | tr -d ' ')"
SO_HASH="$(shasum -a 256 "$SO" | awk '{print $1}')"
say "local build         $SO_SIZE bytes"
say "local sha256        $SO_HASH"
say "cluster             $CLUSTER"

# Refuse to continue if the program is already live and immutable -- there is
# nothing this script could do, and a redeploy attempt would just burn fees.
if EXISTING="$(solana program show "$PROGRAM_ID" --url "$CLUSTER" 2>/dev/null)"; then
  EXISTING_AUTH="$(printf '%s' "$EXISTING" | awk '/Authority:/ {print $2}')"
  say "on chain            already deployed, authority ${EXISTING_AUTH:-none}"
  if [ "${EXISTING_AUTH:-none}" = "none" ]; then
    say ""
    say "This program is already deployed and immutable. Nothing to do."
    say "Verify it with: ./scripts/verify-deployment.sh $CLUSTER"
    exit 0
  fi
else
  say "on chain            not deployed"
fi

PAYER="$(solana address)"
PAYER_BAL="$(solana balance "$PAYER" --url "$CLUSTER" | awk '{print $1}')"
say "hot wallet (payer)  $PAYER  ${PAYER_BAL} SOL"

# Measured on a fork: a 335 KB deploy costs ~2.336 SOL, nearly all of it the
# programdata rent, which the buffer holds first and hands over on deploy.
NEED="2.45"
if [ "$(echo "$PAYER_BAL < $NEED" | bc)" = "1" ]; then
  say ""
  say "The payer needs about $NEED SOL to upload the buffer (the programdata"
  say "rent is paid here, then transferred into the program on deploy)."
  [ "$EXECUTE" = "1" ] && die "payer has $PAYER_BAL SOL, needs ~$NEED"
  say "WARNING: not enough to execute. Top up before running with --execute."
fi

# ----------------------------------------------------------- confirm ledger --

step "confirm the Ledger"

say "Unlock the Ledger and open the Solana app."
if [ "$EXECUTE" = "1" ]; then
  LEDGER_ADDR="$(solana address --keypair "$LEDGER_URL" 2>/dev/null)" \
    || die "cannot read the Ledger at $LEDGER_URL (unlocked? Solana app open?)"
  say "device address      $LEDGER_ADDR"
  if [ -n "$EXPECT_LEDGER" ] && [ "$LEDGER_ADDR" != "$EXPECT_LEDGER" ]; then
    die "device is $LEDGER_ADDR but --expect is $EXPECT_LEDGER.
  Handing authority to the wrong address makes the program permanently
  unupgradeable by you. Check the derivation path (--ledger-url)."
  fi
else
  LEDGER_ADDR="${EXPECT_LEDGER:-<device>}"
  say "device address      $LEDGER_ADDR (not read; dry run)"
fi

if [ "$EXECUTE" != "1" ]; then
  cat <<PLAN

== plan (nothing will be sent)

  1. hot wallet uploads $SO_SIZE bytes into a new buffer account
  2. buffer contents compared byte-for-byte against the local build
  3. buffer authority transferred to $LEDGER_ADDR
  4. LEDGER PRESS 1 -- deploy the buffer as $PROGRAM_ID
  5. deployed bytecode verified against the local build
  6. LEDGER PRESS 2 -- burn the upgrade authority (irreversible)

Re-run with --execute to do it.
PLAN
  exit 0
fi

# --------------------------------------------------------------- 1. buffer ---

step "1/6  upload the buffer (hot wallet, a few hundred transactions)"

BUFFER=""
if [ -f "$STATE" ]; then
  BUFFER="$(cat "$STATE")"
  if solana account "$BUFFER" --url "$CLUSTER" >/dev/null 2>&1; then
    say "reusing the buffer from a previous run: $BUFFER"
  else
    say "recorded buffer $BUFFER is gone; uploading a fresh one"
    BUFFER=""
    rm -f "$STATE"
  fi
fi

if [ -z "$BUFFER" ]; then
  BUFFER_KP="$(mktemp -t nyse-buffer-XXXXXX).json"
  solana-keygen new --no-bip39-passphrase -s -o "$BUFFER_KP" --force >/dev/null
  BUFFER="$(solana-keygen pubkey "$BUFFER_KP")"
  say "buffer              $BUFFER"
  solana program write-buffer "$SO" \
    --buffer "$BUFFER_KP" --url "$CLUSTER" >/dev/null \
    || die "buffer upload failed. Re-run to resume."
  # The buffer is now self-contained on chain; its keypair signs nothing else,
  # because authority moves to the Ledger in step 3.
  shred -u "$BUFFER_KP" 2>/dev/null || rm -f "$BUFFER_KP"
  printf '%s' "$BUFFER" > "$STATE"
  say "uploaded."
fi

# --------------------------------------------------------- 2. verify buffer ---

step "2/6  verify the buffer against the local build"

# A buffer account is UpgradeableLoaderState::Buffer: a 4-byte discriminant,
# a 1-byte Option tag and a 32-byte authority, then the ELF. Strip that 37-byte
# header and the rest must be the bytes we built.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
solana account "$BUFFER" --url "$CLUSTER" --output json 2>/dev/null \
  | python3 -c '
import base64, json, sys
acct = json.load(sys.stdin)["account"]
raw = base64.b64decode(acct["data"][0])
sys.stdout.buffer.write(raw[37:])
' > "$TMP/buffer.bin" || die "could not read the buffer account"

head -c "$SO_SIZE" "$TMP/buffer.bin" > "$TMP/buffer.so"
BUF_HASH="$(shasum -a 256 "$TMP/buffer.so" | awk '{print $1}')"
BUF_LEN="$(wc -c < "$TMP/buffer.bin" | tr -d ' ')"
say "buffer payload      $BUF_LEN bytes"
say "buffer sha256       $BUF_HASH"
[ "$BUF_LEN" -ge "$SO_SIZE" ] || die "buffer holds $BUF_LEN bytes, build is $SO_SIZE -- upload was truncated"
[ "$BUF_HASH" = "$SO_HASH" ] || die "buffer does not match the local build.
  Close it and start over:
    solana program close $BUFFER --url $CLUSTER"
say "matches the local build."

# ------------------------------------------------ 3. hand over to the Ledger --

step "3/6  transfer buffer authority to the Ledger"

CUR_BUF_AUTH="$(solana program show --buffers --url "$CLUSTER" 2>/dev/null \
  | awk -v b="$BUFFER" '$1 == b {print $3}')"
if [ "$CUR_BUF_AUTH" = "$LEDGER_ADDR" ]; then
  say "already set to $LEDGER_ADDR"
else
  solana program set-buffer-authority "$BUFFER" \
    --new-buffer-authority "$LEDGER_ADDR" --url "$CLUSTER" >/dev/null \
    || die "could not transfer buffer authority"
  say "buffer authority    $LEDGER_ADDR"
fi
say "The hot wallet can no longer alter this buffer."

# --------------------------------------------------------------- 4. deploy ---

step "4/6  deploy  <-- LEDGER PRESS 1"
say "Approve on the device. The hot wallet pays the fee; the Ledger authorises"
say "the deploy and becomes the upgrade authority."

solana program deploy \
  --buffer "$BUFFER" \
  --program-id "$PROGRAM_KEYPAIR" \
  --upgrade-authority "$LEDGER_URL" \
  --url "$CLUSTER" \
  || die "deploy failed. The buffer still exists; re-run to retry."

rm -f "$STATE"
say "deployed $PROGRAM_ID"

# --------------------------------------------------------------- 5. verify ---

step "5/6  verify the deployed bytecode"

./scripts/verify-deployment.sh "$CLUSTER" \
  || die "the deployed program does not match the local build. Do NOT burn the
  authority. Redeploy from a fresh buffer first."

# ----------------------------------------------------------------- 6. burn ---

if [ "$BURN" != "1" ]; then
  step "6/6  skipped (--no-burn)"
  say "The Ledger is the upgrade authority. Burn it when you are ready:"
  say "  solana program set-upgrade-authority $PROGRAM_ID --final \\"
  say "    --upgrade-authority $LEDGER_URL --url $CLUSTER"
  exit 0
fi

step "6/6  burn the upgrade authority  <-- LEDGER PRESS 2"
cat <<WARN

This is irreversible. After it, the bytecode can never be changed -- not by
you, not by anyone. A bug found later cannot be patched; a fix would need a new
program id, and every token already launched stays pointed at this one.

The bytecode was just verified against your local build, so what you are making
permanent is what you tested.

WARN
printf 'Type BURN to continue: '
read -r CONFIRM
[ "$CONFIRM" = "BURN" ] || die "not confirmed; the Ledger is still the upgrade authority"

solana program set-upgrade-authority "$PROGRAM_ID" --final \
  --upgrade-authority "$LEDGER_URL" --url "$CLUSTER" \
  || die "could not burn the authority"

FINAL_AUTH="$(solana program show "$PROGRAM_ID" --url "$CLUSTER" | awk '/Authority:/ {print $2}')"
step "done"
say "program             $PROGRAM_ID"
say "upgrade authority   ${FINAL_AUTH:-none}"
if [ "${FINAL_AUTH:-none}" != "none" ]; then
  die "authority is still ${FINAL_AUTH} -- the burn did not take effect"
fi
say ""
say "Immutable. Next: create the registry, which only the bootstrap key can do."
say "  npx tsx scripts/launch-dbc.ts registry --cluster $CLUSTER --ledger --execute"
