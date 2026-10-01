/**
 * Read a mint from chain and report whether it can be listed on each venue.
 *
 * Venue rules are quoted from each protocol's own source or docs; see README.
 * This is read-only -- it fetches accounts and prints a verdict.
 *
 * Usage:
 *   npx ts-node scripts/check-mint-readiness.ts --cluster devnet --mint <MINT>
 */
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ExtensionType,
  getMint,
  getExtensionData,
  getTransferHook,
  getExtensionTypes,
} from "@solana/spl-token";
import { unpack as unpackMetadata } from "@solana/spl-token-metadata";

const HOOK_PROGRAM_ID = new PublicKey("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

type Verdict = "ok" | "warn" | "blocked";
const mark = (v: Verdict) => (v === "ok" ? "  ok   " : v === "warn" ? " warn  " : "BLOCKED");

async function main() {
  const cluster = arg("cluster", "devnet") as "devnet" | "testnet" | "mainnet-beta";
  const mintAddress = new PublicKey(arg("mint"));
  const connection = new Connection(clusterApiUrl(cluster), "confirmed");

  const info = await connection.getAccountInfo(mintAddress);
  if (!info) throw new Error(`mint ${mintAddress.toBase58()} not found on ${cluster}`);
  const isToken2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
  const isLegacyToken = info.owner.equals(TOKEN_PROGRAM_ID);

  const kind = isToken2022
    ? "Token-2022"
    : isLegacyToken
      ? "legacy SPL Token"
      : info.executable
        ? "a PROGRAM, not a mint"
        : "not owned by a token program";

  console.log(`mint     ${mintAddress.toBase58()}`);
  console.log(`cluster  ${cluster}`);
  console.log(`owner    ${info.owner.toBase58()} (${kind})`);

  if (!isToken2022) {
    if (isLegacyToken) {
      console.log("\nLegacy SPL Token mint: it cannot carry a transfer hook. Nothing to check.");
    } else if (info.executable) {
      console.log("\nThis address is a deployed program. Pass a mint address instead.");
    } else {
      console.log("\nThis address is not a token mint. Pass a mint address instead.");
    }
    return;
  }

  const mint = await getMint(connection, mintAddress, "confirmed", TOKEN_2022_PROGRAM_ID);
  const extensions = getExtensionTypes(mint.tlvData);
  const hook = getTransferHook(mint);

  const hookProgram = hook?.programId ?? null;
  const hookActive = hookProgram !== null && !hookProgram.equals(PublicKey.default);
  const hookAuthority = hook?.authority ?? null;
  const hookAuthRevoked =
    hook !== null && (hookAuthority === null || hookAuthority.equals(PublicKey.default));
  const isOurHook = hookActive && hookProgram!.equals(HOOK_PROGRAM_ID);

  let metaName: string | null = null;
  try {
    const raw = getExtensionData(ExtensionType.TokenMetadata, mint.tlvData);
    if (raw) metaName = unpackMetadata(raw).name;
  } catch {
    /* no metadata */
  }

  console.log("\n--- mint configuration ---");
  console.log(`  extensions             ${extensions.map((e) => ExtensionType[e]).join(", ") || "none"}`);
  console.log(`  supply                 ${mint.supply}`);
  console.log(`  decimals               ${mint.decimals}`);
  console.log(`  mint authority         ${mint.mintAuthority?.toBase58() ?? "revoked"}`);
  console.log(`  freeze authority       ${mint.freezeAuthority?.toBase58() ?? "revoked"}`);
  console.log(`  transfer hook program  ${hookActive ? hookProgram!.toBase58() : "not set"}`);
  console.log(`  transfer hook authority${hookAuthRevoked ? " revoked" : " " + hookAuthority?.toBase58()}`);
  console.log(`  metadata name          ${metaName ?? "none on-chain"}`);

  if (hookActive) {
    const code = await connection.getAccountInfo(hookProgram!);
    console.log(`  hook deployed here     ${code?.executable ? "yes" : "NO - not executable on " + cluster}`);
    console.log(`  hook is the NYSE hook  ${isOurHook ? "yes" : "no"}`);
  }

  console.log("\n--- NYSE restriction ---");
  if (!hookActive) {
    console.log("  BLOCKED  No transfer hook. Transfers are unrestricted.");
  } else if (!isOurHook) {
    console.log(`  warn     Hook is ${hookProgram!.toBase58()}, not the NYSE hook.`);
  } else if (!hookAuthRevoked) {
    console.log("  warn     NYSE hook active, but the hook authority is still live:");
    console.log("           whoever holds it can repoint the hook and remove the restriction.");
  } else {
    console.log("  ok       NYSE hook active and permanently locked in.");
  }

  // Venue rules. Sources are in the README's venue section.
  console.log("\n--- venue readiness ---");
  const rows: [string, Verdict, string][] = [
    [
      "Orca Whirlpools",
      hookActive ? "warn" : "ok",
      hookActive
        ? "TokenBadge required. is_supported_token_mint returns false for TransferHook unless a badge is initialized. Hook stays active once badged."
        : "No hook, permissionless.",
    ],
    [
      "Meteora DAMM v2",
      hookActive ? "blocked" : "ok",
      hookActive
        ? "TransferHook permissionless only when program id AND authority are unset. No general hook remaining-account surface for swaps, so an active hook fails token movement even with a badge."
        : "Revoked hook is permissionless.",
    ],
    [
      "Meteora DLMM",
      hookActive ? "blocked" : "ok",
      hookActive
        ? "TransferHook permissionless only when program and authority are revoked. Active hook needs a token badge; hook account forwarding is undocumented."
        : "Revoked hook is permissionless.",
    ],
    [
      "Meteora DBC",
      hookActive ? "warn" : "ok",
      hookActive
        ? "Hook runs during the bonding curve, but DBC revokes the hook program id and authority on completion. The restriction ends at graduation."
        : "Standard pool.",
    ],
  ];

  for (const [venue, verdict, note] of rows) {
    console.log(`  [${mark(verdict)}] ${venue}`);
    console.log(`            ${note}`);
  }

  if (hookActive && isOurHook && hookAuthRevoked) {
    console.log("\nFor a permanently NYSE-restricted token, Orca Whirlpools with a TokenBadge");
    console.log("is the only listed venue that keeps the hook alive. Build instructions with");
    console.log("@orca-so/whirlpools-sdk (legacy); the newer @orca-so/whirlpools does not");
    console.log("attach hook remaining accounts yet (orca-so/whirlpools issue #1372).");
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
