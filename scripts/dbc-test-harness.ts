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
import { DynamicBondingCurveClient, SwapMode, deriveTokenBadgeAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import * as t from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";

const DBC = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
const DAMM2 = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const HOOK = new PublicKey("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");

/** Exact UTC epochs for the stated Eastern wall-clock times. */
// Defaults suit NYSE. Any market can be exercised by passing its own epochs:
//   --open-ts <SECONDS>    a moment the schedule should ALLOW
//   --closed-ts <SECONDS>  a moment it should BLOCK
// Useful for proving a schedule is really the one it claims: 2026-09-28 12:00
// ET is inside NYSE hours but past the London close, so an LSE token must
// block there while an NYSE token trades.
const OPEN = BigInt(argOr("open-ts", "1790607600"));      // Mon 2026-09-28 11:00 ET
const SATURDAY = BigInt(argOr("closed-ts", "1791039600")); // Sat 2026-10-03 11:00 ET

function argOr(n: string, d: string): string {
  const i = process.argv.indexOf(`--${n}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
}

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
  // withSplPrograms() bundles a Token-2022 older than mainnet's, which cannot
  // parse ScaledUiAmountConfig or PausableConfig -- both of which every xStock
  // quote mint carries. Override it with the real one.
  if (fs.existsSync("fixtures/dbc/token2022.so")) {
    svm.addProgramFromFile(t.TOKEN_2022_PROGRAM_ID, "fixtures/dbc/token2022.so");
  }
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
      if (process.argv.includes("--verbose")) {
        for (const l of logs) console.log("      " + l);
        tx.instructions.forEach((ix, i) => {
          console.log(`      ix[${i}] ${ix.programId.toBase58()}`);
          ix.keys.forEach((k, j) => console.log(`         [${j}] ${k.pubkey.toBase58()} ${k.isSigner?"S":" "}${k.isWritable?"W":" "}`));
        });
      }
      return null;
    }
    console.log(`  ${label.padEnd(34)} OK      CU ${(r as any).computeUnitsConsumed()}`);
    return r;
  }
  const bal = (k: PublicKey) => { const a = svm.getAccount(k); return a ? Buffer.from(a.data).readBigUInt64LE(64) : 0n; };
  const poolState = () =>
    (client as any).state.program.coder.accounts.decode("transferHookPool", Buffer.from(svm.getAccount(pool)!.data)).poolState;

  const op = (await client.state.getPool(pool))!.poolState as any;

  // The pool may be quoted in SOL or in a tokenised stock. Everything below --
  // what has to be cloned, how the buyer is funded, how amounts are printed --
  // depends on which, so read it off the config rather than assuming SOL.
  const cfgState: any = await client.state.getPoolConfig(op.config);
  const quoteMint: PublicKey = (cfgState.configState ?? cfgState).quoteMint;
  const isSol = quoteMint.equals(t.NATIVE_MINT);
  const quoteInfoRpc = await c.getAccountInfo(quoteMint);
  const quoteProgram = quoteInfoRpc!.owner;
  const quoteDecimals = (await t.getMint(c, quoteMint, "confirmed", quoteProgram)).decimals;
  const QUOTE_SYMBOLS: Record<string, string> = {
    So11111111111111111111111111111111111111112: "SOL",
    Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ: "QQQx",
  };
  const qSym = QUOTE_SYMBOLS[quoteMint.toBase58()] ?? quoteMint.toBase58().slice(0, 8);
  const qUnit = 10 ** quoteDecimals;
  const fmtQ = (n: bigint | number) => (Number(n) / qUnit).toFixed(6) + " " + qSym;
  console.log(`quote: ${qSym} (${quoteDecimals} decimals, ${isSol ? "SPL" : "Token-2022"})\n`);

  for (const pk of [pool, mint, op.config, op.baseVault, op.quoteVault, ata, quoteMint]) await cloneOne(pk);
  if (!isSol) await cloneOne(deriveTokenBadgeAddress(quoteMint));

  // A SOL swap wraps lamports on the fly. A stock-quoted swap spends from an
  // existing token account, and the xStock mint authority is Backed's, so the
  // balance is fabricated directly in the SVM.
  const quoteAta = t.getAssociatedTokenAddressSync(quoteMint, payer.publicKey, false, quoteProgram, t.ASSOCIATED_TOKEN_PROGRAM_ID);
  const FUND = 1_000_000n * BigInt(qUnit);
  if (!isSol) {
    // A SOL swap wraps lamports on the fly. A stock-quoted swap spends from an
    // existing token account, and the xStock mint authority is Backed's, so
    // the buyer has to be funded some other way.
    //
    // Let the ATA program build the account rather than hand-rolling one: an
    // xStock mint carries extensions, so the correct account layout is not
    // just a bare 165-byte Account, and getting it wrong is rejected with a
    // misleading "Provided owner is not allowed". Then overwrite the amount
    // field in place, which is the one thing no instruction would let us do.
    const mk = new Transaction().add(
      t.createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, quoteAta, payer.publicKey, quoteMint, quoteProgram, t.ASSOCIATED_TOKEN_PROGRAM_ID));
    await clone(mk);
    if (!run(mk, [], "create buyer quote ATA")) process.exit(1);
    const created = svm.getAccount(quoteAta)!;
    const data = Buffer.from(created.data);
    data.writeBigUInt64LE(FUND, 64); // Account.amount
    svm.setAccount(quoteAta, { ...created, data });
    seen.add(quoteAta.toBase58());
    console.log(`  funded buyer with ${fmtQ(FUND)}\n`);
  }

  const swap = async (lamports: bigint, baseForQuote: boolean) =>
    client.pool.swap2WithTransferHook({
      owner: payer.publicKey, payer: payer.publicKey, pool,
      swapBaseForQuote: baseForQuote, referralTokenAccount: null,
      swapMode: SwapMode.ExactIn, amountIn: new BN(lamports.toString()), minimumAmountOut: new BN(0),
    } as any);

  console.log(`MARKET SHOULD BE OPEN (ts ${OPEN})`);
  setClock(OPEN);
  const BUY = BigInt(qUnit) / 2n; // half a quote token
  let tx = await swap(BUY, false); await clone(tx);
  if (!run(tx, [], `buy ${fmtQ(BUY)}`)) process.exit(1);
  const held = bal(ata);
  tx = await swap(held / 2n, true); await clone(tx);
  run(tx, [], "sell half back");

  const f = poolState();
  const qFee = BigInt(f.partnerQuoteFee.toString()), bFee = BigInt(f.partnerBaseFee.toString());
  console.log(`  partner fees accrued:              ${fmtQ(qFee)}`);

  const recv = () => (isSol ? svm.getBalance(payer.publicKey)! : bal(quoteAta));
  const before = recv();
  tx = await client.partner.claimPartnerTradingFee2({
    feeClaimer: payer.publicKey, payer: payer.publicKey, pool, receiver: payer.publicKey,
    maxBaseAmount: new BN(bFee.toString()), maxQuoteAmount: new BN(qFee.toString()),
  });
  await clone(tx);
  if (run(tx, [], "claimPartnerTradingFee2")) {
    console.log(`  received:                          ${fmtQ(recv() - before)}`);
  }

  // The creator's share is a separate pot with a separate claimer. On a tier
  // with a non-zero creator share this must also pay out.
  const afterPartner = poolState();
  const cQuote = BigInt(afterPartner.creatorQuoteFee.toString());
  const cBase = BigInt(afterPartner.creatorBaseFee.toString());
  console.log(`  creator fees accrued:              ${fmtQ(cQuote)}`);
  if (cQuote > 0n || cBase > 0n) {
    const beforeC = recv();
    tx = await client.creator.claimCreatorTradingFee2({
      creator: payer.publicKey, payer: payer.publicKey, pool, receiver: payer.publicKey,
      maxBaseAmount: new BN(cBase.toString()), maxQuoteAmount: new BN(cQuote.toString()),
    } as any);
    await clone(tx);
    if (run(tx, [], "claimCreatorTradingFee2")) {
      console.log(`  received:                          ${fmtQ(recv() - beforeC)}`);
      const left = poolState();
      console.log(`  creator fees left in pool:         ${fmtQ(BigInt(left.creatorQuoteFee.toString()))}`);
    }
  } else {
    console.log("  (this config has a 0% creator share, nothing to claim)");
  }

  console.log(`\nMARKET SHOULD BE CLOSED (ts ${SATURDAY})`);
  setClock(SATURDAY);
  tx = await swap(BigInt(qUnit) / 10n, false); await clone(tx);
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
