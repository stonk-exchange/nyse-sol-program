/**
 * Verify scripts/markets/quotes.ts against the chain.
 *
 * Every quote-denominated number in a DBC config is in the quote's base units,
 * so a wrong decimal count silently builds a curve a factor of ten off. And a
 * Token-2022 quote mint cannot be used at all without a DBC token badge. Both
 * are checked here rather than trusted.
 *
 *   npx tsx scripts/check-quotes.ts [--cluster mainnet-beta]
 *
 * Exits non-zero on any mismatch.
 */
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import {
  unpackMint, getExtensionData, ExtensionType,
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { unpack } from "@solana/spl-token-metadata";
import { deriveTokenBadgeAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { QUOTES } from "./markets/quotes";

const cluster = (() => {
  const i = process.argv.indexOf("--cluster");
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : "mainnet-beta";
})();

async function main() {
  const connection = new Connection(
    process.env.RPC_URL ?? clusterApiUrl(cluster as any), "confirmed");

  const entries = Object.values(QUOTES);
  const mints = entries.map((q) => new PublicKey(q.mint));
  const badges = mints.map(deriveTokenBadgeAddress);

  // One batched read rather than 32 single ones: the public RPC rate-limits.
  const [mintInfos, badgeInfos] = await Promise.all([
    connection.getMultipleAccountsInfo(mints),
    connection.getMultipleAccountsInfo(badges),
  ]);

  const problems: string[] = [];
  console.log(`checking ${entries.length} quote mints on ${cluster}\n`);
  console.log("symbol   decimals  program     badge   name");

  entries.forEach((q, i) => {
    const info = mintInfos[i];
    if (!info) { problems.push(`${q.symbol}: mint ${q.mint} does not exist`); return; }

    const is2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
    const isSpl = info.owner.equals(TOKEN_PROGRAM_ID);
    if (!is2022 && !isSpl) { problems.push(`${q.symbol}: owned by ${info.owner.toBase58()}, not a token program`); return; }

    const mint = unpackMint(mints[i], info, info.owner);
    if (mint.decimals !== q.decimals) {
      problems.push(`${q.symbol}: preset says ${q.decimals} decimals, chain says ${mint.decimals}`);
    }

    // Token-2022 quote mints are not permissionless on DBC; they need a badge.
    const hasBadge = badgeInfos[i] !== null;
    if (is2022 && !hasBadge) {
      problems.push(`${q.symbol}: Token-2022 with no DBC token badge (${badges[i].toBase58()}) -- unusable as a quote mint`);
    }

    // Wrapped SOL carries no metadata extension; the xStocks all do.
    let onChainSymbol = "";
    if (is2022) {
      try {
        const raw = getExtensionData(ExtensionType.TokenMetadata, mint.tlvData);
        if (raw) onChainSymbol = unpack(raw).symbol;
      } catch { /* no metadata extension */ }
    }
    if (onChainSymbol && onChainSymbol !== q.symbol) {
      problems.push(`${q.symbol}: on-chain metadata symbol is '${onChainSymbol}'`);
    }

    console.log(
      `${q.symbol.padEnd(8)} ${String(mint.decimals).padEnd(9)} ` +
      `${(is2022 ? "Token-2022" : "SPL").padEnd(11)} ${(hasBadge ? "yes" : "--").padEnd(7)} ${q.name}`
    );
  });

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`\nall ${entries.length} quote mints check out`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
