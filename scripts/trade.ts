/**
 * Buy or sell a hooked token on its DBC pool.
 *
 * Mostly for proving a launch actually works: the fork tests show the hook
 * behaves, but only a real swap shows that a real pool, a real hook and a real
 * wallet agree. It is also the only way to put fees into a pool so the claim
 * path can be exercised.
 *
 *   npx tsx scripts/trade.ts --pool <POOL> --amount 0.01            # dry run
 *   npx tsx scripts/trade.ts --pool <POOL> --amount 0.01 --execute  # buy
 *   npx tsx scripts/trade.ts --pool <POOL> --amount 1000 --sell --execute
 *
 * --amount is in whole quote tokens when buying, whole base tokens when
 * selling. The signer is ANCHOR_WALLET (or the Solana CLI default).
 */
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
  sendAndConfirmTransaction, clusterApiUrl,
} from "@solana/web3.js";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import * as t from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import { QUOTES } from "./markets/quotes";

const BASE_DECIMALS = 6;

function arg(n: string, d?: string): string {
  const i = process.argv.indexOf(`--${n}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (d !== undefined) return d;
  throw new Error(`missing --${n}`);
}

async function main() {
  const cluster = arg("cluster", "mainnet-beta");
  const endpoint = arg("rpc", cluster.startsWith("http") ? cluster : clusterApiUrl(cluster as any));
  const pool = new PublicKey(arg("pool"));
  const sell = process.argv.includes("--sell");
  const execute = process.argv.includes("--execute");

  const walletPath = (process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`).replace(/^~/, os.homedir());
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));

  const connection = new Connection(endpoint, "confirmed");
  const client = DynamicBondingCurveClient.create(connection, "confirmed");

  const state = await client.state.getPool(pool);
  if (!state) throw new Error(`no DBC pool at ${pool.toBase58()}`);
  const ps: any = (state as any).poolState ?? state;
  const cfg: any = await client.state.getPoolConfig(ps.config);
  const cs = cfg.configState ?? cfg;
  const quoteMint: PublicKey = cs.quoteMint;
  const qInfo = await connection.getAccountInfo(quoteMint);
  const qDec = (await t.getMint(connection, quoteMint, "confirmed", qInfo!.owner)).decimals;
  const qSym = Object.values(QUOTES).find((q) => q.mint === quoteMint.toBase58())?.symbol ?? quoteMint.toBase58();

  const inDecimals = sell ? BASE_DECIMALS : qDec;
  const amount = Number(arg("amount"));
  const amountIn = new BN(Math.round(amount * 10 ** inDecimals).toString());

  console.log(sell ? "SELL" : "BUY");
  console.log(`  endpoint   ${endpoint}`);
  console.log(`  pool       ${pool.toBase58()}`);
  console.log(`  base mint  ${ps.baseMint.toBase58()}`);
  console.log(`  quote      ${qSym} (${qDec} decimals)`);
  console.log(`  signer     ${payer.publicKey.toBase58()}`);
  console.log(`  amount in  ${amount} ${sell ? "base tokens" : qSym}`);
  console.log(`  fees so far  partner ${Number(ps.partnerQuoteFee) / 10 ** qDec} ${qSym}` +
    `  creator ${Number(ps.creatorQuoteFee) / 10 ** qDec} ${qSym}`);

  if (!execute) { console.log("\nDry run. Add --execute to send."); return; }

  const tx = await client.pool.swap2WithTransferHook({
    owner: payer.publicKey,
    payer: payer.publicKey,
    pool,
    swapBaseForQuote: sell,
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn,
    // Acceptable only because these are deliberately tiny proving trades on a
    // pool nobody else is touching. Anything real wants a quote and a bound.
    minimumAmountOut: new BN(0),
  } as any);
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
    console.log("\nswap:", sig);
  } catch (e: any) {
    const logs: string[] = e?.logs ?? (await e?.getLogs?.(connection)) ?? [];
    const hit = logs.find((l) => l.includes("Error Message:"));
    if (hit) {
      console.log("\nSWAP REJECTED");
      console.log("  " + hit.replace(/^Program log: /, ""));
      if (/MarketClosed/.test(hit)) {
        console.log("  This is the hook doing its job -- the market is shut.");
      }
      return;
    }
    throw e;
  }

  const after = await client.state.getPool(pool);
  const as: any = (after as any).poolState ?? after;
  console.log(`  fees now     partner ${Number(as.partnerQuoteFee) / 10 ** qDec} ${qSym}` +
    `  creator ${Number(as.creatorQuoteFee) / 10 ** qDec} ${qSym}`);
  const ata = t.getAssociatedTokenAddressSync(ps.baseMint, payer.publicKey, false, t.TOKEN_2022_PROGRAM_ID);
  const bal = await connection.getTokenAccountBalance(ata).catch(() => null);
  if (bal) console.log(`  you now hold ${bal.value.uiAmountString} base tokens`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
