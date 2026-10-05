/**
 * Exercise a live DBC pool with a warped clock.
 *
 * DBC transactions have to be BUILT against an RPC, but a validator's clock
 * follows real time, so market-hours behaviour cannot be tested there. This
 * builds each transaction against the validator, clones every account it
 * touches into LiteSVM, and executes it with the clock set wherever we want.
 *
 * Setup:
 *   ./scripts/fetch-dbc-fixtures.sh
 *   solana-test-validator --reset \
 *     --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN fixtures/dbc/dbc.so \
 *     --bpf-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG fixtures/dbc/dammv2.so \
 *     --bpf-program CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k target/deploy/nyse_token_hook.so \
 *     --clone So11111111111111111111111111111111111111112 --url mainnet-beta
 *   npx ts-node scripts/launch-dbc.ts config --rpc http://127.0.0.1:8899 ... --execute
 *   npx ts-node scripts/launch-dbc.ts token  --rpc http://127.0.0.1:8899 ... --execute
 *   npx ts-node scripts/dbc-test-harness.ts --pool <POOL> --mint <MINT>
 *
 * Verified with this harness:
 *   buy / sell during market hours      succeed
 *   buy on a Saturday                   blocked, MarketClosedWeekend (6000)
 *   claimPartnerTradingFee2             pays out, pool drains to zero
 *   claiming while the market is closed succeeds (fees are quote-side, unhooked)
 *
 * NOT yet verified: graduation. The curve funds to the migration threshold but
 * migrationProgress stays 0 here, so migrateToDammV2 is never reachable and the
 * post-graduation hook state is untested. Meteora documents that DBC revokes
 * the hook program id and authority on completion; this harness has not
 * reproduced it.
 */
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { DynamicBondingCurveClient, SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import * as t from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";

const DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const DAMM2 = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const HOOK = new PublicKey("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");

/** Exact UTC epochs for the stated Eastern wall-clock times. */
const OPEN = 1_790_607_600n;      // Mon 2026-09-28 11:00 ET
const SATURDAY = 1_791_039_600n;  // Sat 2026-10-03 11:00 ET

function arg(n: string, d?: string): string {
  const i = process.argv.indexOf(`--${n}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (d !== undefined) return d;
  throw new Error(`missing --${n}`);
}

(async () => {
  const rpc = arg("rpc", "http://127.0.0.1:8899");
  const pool = new PublicKey(arg("pool"));
  const mint = new PublicKey(arg("mint"));
  const walletPath = (process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`).replace(/^~/, os.homedir());
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));

  const c = new Connection(rpc, "confirmed");
  const client = DynamicBondingCurveClient.create(c, "confirmed");
  const ata = t.getAssociatedTokenAddressSync(mint, payer.publicKey, false, t.TOKEN_2022_PROGRAM_ID, t.ASSOCIATED_TOKEN_PROGRAM_ID);

  const svm = new LiteSVM().withBuiltins().withSplPrograms().withSysvars();
  svm.addProgramFromFile(DBC, "fixtures/dbc/dbc.so");
  if (fs.existsSync("fixtures/dbc/dammv2.so")) svm.addProgramFromFile(DAMM2, "fixtures/dbc/dammv2.so");
  svm.addProgramFromFile(HOOK, "target/deploy/nyse_token_hook.so");
  svm.airdrop(payer.publicKey, 100_000n * 1_000_000_000n);

  const seen = new Set<string>();
  const cloneOne = async (pk: PublicKey) => {
    const s = pk.toBase58();
    if (seen.has(s) || pk.equals(payer.publicKey)) return;
    seen.add(s);
    const info = await c.getAccountInfo(pk);
    if (!info || info.executable) return;
    svm.setAccount(pk, { lamports: info.lamports, data: info.data, owner: info.owner, executable: false, rentEpoch: 0 });
  };
  const clone = async (tx: Transaction) => {
    for (const ix of tx.instructions) { await cloneOne(ix.programId); for (const k of ix.keys) await cloneOne(k.pubkey); }
  };
  const setClock = (ts: bigint) => { const cl = svm.getClock(); cl.unixTimestamp = ts; svm.setClock(cl); };
  function run(tx: Transaction, signers: Keypair[], label: string) {
    svm.expireBlockhash();
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = payer.publicKey;
    tx.signatures = [];
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    tx.sign(payer, ...signers);
    const r = svm.sendTransaction(tx);
    if (r instanceof FailedTransactionMetadata) {
      const logs = (r as any).meta?.().logs?.() ?? [];
      const m = logs.find((l: string) => l.includes("Error Message:"));
      console.log(`  ${label.padEnd(34)} FAILED  ${(m ?? r.err().toString()).replace(/^Program log: /, "").slice(0, 60)}`);
      return null;
    }
    console.log(`  ${label.padEnd(34)} OK      CU ${(r as any).computeUnitsConsumed()}`);
    return r;
  }
  const bal = (k: PublicKey) => { const a = svm.getAccount(k); return a ? Buffer.from(a.data).readBigUInt64LE(64) : 0n; };
  const poolState = () =>
    (client as any).state.program.coder.accounts.decode("transferHookPool", Buffer.from(svm.getAccount(pool)!.data)).poolState;

  const op = (await client.state.getPool(pool))!.poolState as any;
  for (const pk of [pool, mint, op.config, op.baseVault, op.quoteVault, ata, t.NATIVE_MINT]) await cloneOne(pk);

  const swap = async (lamports: bigint, baseForQuote: boolean) =>
    client.pool.swap2WithTransferHook({
      owner: payer.publicKey, payer: payer.publicKey, pool,
      swapBaseForQuote: baseForQuote, referralTokenAccount: null,
      swapMode: SwapMode.ExactIn, amountIn: new BN(lamports.toString()), minimumAmountOut: new BN(0),
    } as any);

  console.log("MARKET OPEN (Mon 11:00 ET)");
  setClock(OPEN);
  let tx = await swap(500_000_000n, false); await clone(tx);
  if (!run(tx, [], "buy 0.5 SOL")) process.exit(1);
  const held = bal(ata);
  tx = await swap(held / 2n, true); await clone(tx);
  run(tx, [], "sell half back");

  const f = poolState();
  const qFee = BigInt(f.partnerQuoteFee.toString()), bFee = BigInt(f.partnerBaseFee.toString());
  console.log(`  partner fees accrued:              ${(Number(qFee) / 1e9).toFixed(6)} SOL`);

  const before = svm.getBalance(payer.publicKey)!;
  tx = await client.partner.claimPartnerTradingFee2({
    feeClaimer: payer.publicKey, payer: payer.publicKey, pool, receiver: payer.publicKey,
    maxBaseAmount: new BN(bFee.toString()), maxQuoteAmount: new BN(qFee.toString()),
  });
  await clone(tx);
  if (run(tx, [], "claimPartnerTradingFee2")) {
    console.log(`  SOL received:                      ${(Number(svm.getBalance(payer.publicKey)! - before) / 1e9).toFixed(6)}`);
  }

  // The creator's share is a separate pot with a separate claimer. On a tier
  // with a non-zero creator share this must also pay out.
  const afterPartner = poolState();
  const cQuote = BigInt(afterPartner.creatorQuoteFee.toString());
  const cBase = BigInt(afterPartner.creatorBaseFee.toString());
  console.log(`  creator fees accrued:              ${(Number(cQuote) / 1e9).toFixed(6)} SOL`);
  if (cQuote > 0n || cBase > 0n) {
    const beforeC = svm.getBalance(payer.publicKey)!;
    tx = await client.creator.claimCreatorTradingFee2({
      creator: payer.publicKey, payer: payer.publicKey, pool, receiver: payer.publicKey,
      maxBaseAmount: new BN(cBase.toString()), maxQuoteAmount: new BN(cQuote.toString()),
    } as any);
    await clone(tx);
    if (run(tx, [], "claimCreatorTradingFee2")) {
      console.log(`  SOL received:                      ${(Number(svm.getBalance(payer.publicKey)! - beforeC) / 1e9).toFixed(6)}`);
      const left = poolState();
      console.log(`  creator fees left in pool:         ${(Number(left.creatorQuoteFee) / 1e9).toFixed(6)} SOL`);
    }
  } else {
    console.log("  (this config has a 0% creator share, nothing to claim)");
  }

  console.log("\nMARKET CLOSED (Sat 11:00 ET)");
  setClock(SATURDAY);
  tx = await swap(100_000_000n, false); await clone(tx);
  run(tx, [], "buy (must fail)");
  const f2 = poolState();
  tx = await client.partner.claimPartnerTradingFee2({
    feeClaimer: payer.publicKey, payer: payer.publicKey, pool, receiver: payer.publicKey,
    maxBaseAmount: new BN(f2.partnerBaseFee.toString()), maxQuoteAmount: new BN(f2.partnerQuoteFee.toString()),
  });
  await clone(tx);
  run(tx, [], "claim fees while closed");

  if (process.argv.includes("--graduate")) {
    console.log("\nGRADUATION ATTEMPT");
    setClock(OPEN);
    const threshold = BigInt(poolState().migrationQuoteThreshold?.toString() ?? "127426820765");
    for (let i = 0; i < 60; i++) {
      const res = BigInt(poolState().quoteReserve.toString());
      if (res >= threshold) break;
      let amt = threshold - res;
      if (amt > 20_000_000_000n) amt = 20_000_000_000n;
      const b = await swap(amt, false); await clone(b);
      svm.expireBlockhash(); b.recentBlockhash = svm.latestBlockhash(); b.feePayer = payer.publicKey; b.signatures = [];
      b.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
      b.sign(payer);
      if (svm.sendTransaction(b) instanceof FailedTransactionMetadata) break;
    }
    const p = poolState();
    console.log(`  quoteReserve ${(Number(p.quoteReserve) / 1e9).toFixed(3)} / ${(Number(threshold) / 1e9).toFixed(3)} SOL, migrationProgress=${p.migrationProgress}`);
    if (p.migrationProgress === 0) {
      console.log("  curve did not flip to complete in this harness; migration not reachable");
    }
  }
})().catch((e) => { console.error("ERROR:", e.message ?? e); process.exit(1); });
