/**
 * Compute-budget benchmark: what does the NYSE hook actually cost?
 *
 * Builds two identical Orca pools -- one whose base mint carries the hook, one
 * whose base mint is a plain Token-2022 mint -- and runs the same operations on
 * both. The delta is the hook's marginal cost.
 */
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, Connection, SystemProgram, Transaction, TransactionInstruction, AccountMeta, ComputeBudgetProgram } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { WhirlpoolContext, WhirlpoolIx, ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil, PriceMath } from "@orca-so/whirlpools-sdk";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType,
  getMintLen, createInitializeMintInstruction, createInitializeTransferHookInstruction,
  createAssociatedTokenAccountInstruction, createMintToInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";

const HOOK = new PublicKey("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");
const OPEN = 1_790_607_600n;
const TICK_SPACING = 64;
const TPA = 88 * TICK_SPACING;

const svm = new LiteSVM().withBuiltins().withSplPrograms().withSysvars()
  .withComputeBudget((() => { const { ComputeBudget } = require("litesvm"); const b = new ComputeBudget(); b.computeUnitLimit = 1_400_000n; return b; })());
svm.addProgramFromFile(ORCA_WHIRLPOOL_PROGRAM_ID, "fixtures/orca/whirlpool.so");
svm.addProgramFromFile(HOOK, "target/deploy/nyse_token_hook.so");

const payer = Keypair.generate();
svm.airdrop(payer.publicKey, 100_000n * 1_000_000_000n);
const setClock = (ts: bigint) => { const c = svm.getClock(); c.unixTimestamp = ts; svm.setClock(c); };
setClock(OPEN);

const saved = JSON.parse(fs.readFileSync("fixtures/orca/config.json", "utf8"));
const CONFIG = new PublicKey(saved.config.pk);
const clone = (rec: any, patches: [number, PublicKey][]) => {
  const data = Buffer.from(rec.data, "base64");
  for (const [off, pk] of patches) pk.toBuffer().copy(data, off);
  svm.setAccount(new PublicKey(rec.pk), { lamports: rec.lamports, data, owner: new PublicKey(rec.owner), executable: false, rentEpoch: 0 });
};
clone(saved.config, [[8, payer.publicKey], [40, payer.publicKey], [72, payer.publicKey]]);
clone(saved.ext, [[40, payer.publicKey], [72, payer.publicKey]]);
clone(saved.feeTier, []);
const feeTierKey = new PublicKey(saved.feeTier.pk);

const wallet = { publicKey: payer.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t };
const provider = new anchor.AnchorProvider(new Connection("http://127.0.0.1:8899"), wallet as any, {});
const ctx = WhirlpoolContext.withProvider(provider, undefined, undefined, undefined, ORCA_WHIRLPOOL_PROGRAM_ID);

function send(ixs: TransactionInstruction[], signers: Keypair[], label: string) {
  svm.expireBlockhash();
  const tx = new Transaction();
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  ixs.forEach(i => tx.add(i));
  tx.sign(payer, ...signers);
  const r = svm.sendTransaction(tx);
  if (r instanceof FailedTransactionMetadata) {
    console.log(`  FAIL ${label}`);
    (r.meta?.().logs?.() ?? []).slice(-4).forEach((l: string) => console.log(`        ${l}`));
    return null;
  }
  return r;
}

/** Build a pool whose base mint either carries the hook or does not. */
function buildPool(hooked: boolean, sharedQuote?: Keypair) {
  const quote = sharedQuote ?? Keypair.generate();
  let base: Keypair;
  do { base = Keypair.generate(); } while (Buffer.compare(base.publicKey.toBuffer(), quote.publicKey.toBuffer()) >= 0);

  const [extraMetas] = PublicKey.findProgramAddressSync([Buffer.from("extra-account-metas"), base.publicKey.toBuffer()], HOOK);
  const hookAccounts: AccountMeta[] = hooked
    ? [{ pubkey: HOOK, isSigner: false, isWritable: false }, { pubkey: extraMetas, isSigner: false, isWritable: false }]
    : [];

  const mintLen = getMintLen(hooked ? [ExtensionType.TransferHook] : []);
  const ixs: TransactionInstruction[] = [
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: base.publicKey, space: mintLen,
      lamports: Number(svm.minimumBalanceForRentExemption(BigInt(mintLen))), programId: TOKEN_2022_PROGRAM_ID }),
  ];
  if (hooked) ixs.push(createInitializeTransferHookInstruction(base.publicKey, payer.publicKey, HOOK, TOKEN_2022_PROGRAM_ID));
  ixs.push(createInitializeMintInstruction(base.publicKey, 9, payer.publicKey, null, TOKEN_2022_PROGRAM_ID));
  send(ixs, [base], "base mint");

  if (hooked) {
    send([{ programId: HOOK, keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: extraMetas, isSigner: false, isWritable: true },
      { pubkey: base.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
      data: createHash("sha256").update("global:initialize_extra_account_meta_list").digest().subarray(0, 8),
    } as TransactionInstruction], [], "hook state");
  }

  if (!sharedQuote) {
    const qLen = getMintLen([]);
    send([
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: quote.publicKey, space: qLen,
        lamports: Number(svm.minimumBalanceForRentExemption(BigInt(qLen))), programId: TOKEN_PROGRAM_ID }),
      createInitializeMintInstruction(quote.publicKey, 9, payer.publicKey, null, TOKEN_PROGRAM_ID),
    ], [quote], "quote mint");
  }

  const ataA = getAssociatedTokenAddressSync(base.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const ataB = getAssociatedTokenAddressSync(quote.publicKey, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const ataIxs: TransactionInstruction[] = [
    createAssociatedTokenAccountInstruction(payer.publicKey, ataA, payer.publicKey, base.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createMintToInstruction(base.publicKey, ataA, payer.publicKey, 10n ** 18n, [], TOKEN_2022_PROGRAM_ID),
  ];
  if (!sharedQuote) {
    ataIxs.push(createAssociatedTokenAccountInstruction(payer.publicKey, ataB, payer.publicKey, quote.publicKey, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    ataIxs.push(createMintToInstruction(quote.publicKey, ataB, payer.publicKey, 10n ** 18n, [], TOKEN_PROGRAM_ID));
  }
  send(ataIxs, [], "atas");

  const badgeA = PDAUtil.getTokenBadge(ORCA_WHIRLPOOL_PROGRAM_ID, CONFIG, base.publicKey);
  const badgeB = PDAUtil.getTokenBadge(ORCA_WHIRLPOOL_PROGRAM_ID, CONFIG, quote.publicKey).publicKey;
  if (hooked) {
    send(WhirlpoolIx.initializeTokenBadgeIx(ctx.program, {
      whirlpoolsConfig: CONFIG, whirlpoolsConfigExtension: PDAUtil.getConfigExtension(ORCA_WHIRLPOOL_PROGRAM_ID, CONFIG).publicKey,
      tokenBadgeAuthority: payer.publicKey, tokenMint: base.publicKey, tokenBadgePda: badgeA, funder: payer.publicKey,
    }).instructions, [], "badge");
  }

  const poolPda = PDAUtil.getWhirlpool(ORCA_WHIRLPOOL_PROGRAM_ID, CONFIG, base.publicKey, quote.publicKey, TICK_SPACING);
  const vA = Keypair.generate(), vB = Keypair.generate();
  send(WhirlpoolIx.initializePoolV2Ix(ctx.program, {
    whirlpoolsConfig: CONFIG, tokenMintA: base.publicKey, tokenMintB: quote.publicKey,
    tokenBadgeA: badgeA.publicKey, tokenBadgeB: badgeB,
    tokenProgramA: TOKEN_2022_PROGRAM_ID, tokenProgramB: TOKEN_PROGRAM_ID,
    funder: payer.publicKey, whirlpoolPda: poolPda, tokenVaultAKeypair: vA, tokenVaultBKeypair: vB,
    feeTierKey, tickSpacing: TICK_SPACING, initSqrtPrice: PriceMath.tickIndexToSqrtPriceX64(0),
  }).instructions, [vA, vB], "pool");

  for (const s of [-2 * TPA, -TPA, 0, TPA]) {
    send(WhirlpoolIx.initTickArrayIx(ctx.program, {
      whirlpool: poolPda.publicKey, tickArrayPda: PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, poolPda.publicKey, s),
      startTick: s, funder: payer.publicKey,
    }).instructions, [], `tickArray ${s}`);
  }

  // Spread liquidity across several narrow positions so a large swap has to
  // cross many initialised ticks -- the expensive case.
  const liqCU: number[] = [];
  for (const [lo, hi] of [[-640, 640], [-1920, -640], [-3200, -1920], [-5632, -3200], [-9984, -5632]]) {
    const pm = Keypair.generate();
    const pp = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, pm.publicKey);
    const pta = getAssociatedTokenAddressSync(pm.publicKey, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    send(WhirlpoolIx.openPositionIx(ctx.program, {
      funder: payer.publicKey, owner: payer.publicKey, positionPda: pp, positionMintAddress: pm.publicKey,
      positionTokenAccount: pta, whirlpool: poolPda.publicKey, tickLowerIndex: lo, tickUpperIndex: hi,
    }).instructions, [pm], `position ${lo}..${hi}`);

    const arrFor = (t: number) => PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, poolPda.publicKey, Math.floor(t / TPA) * TPA).publicKey;
    const r = send(WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, {
      liquidityAmount: new anchor.BN(500_000_000),
      tokenMaxA: new anchor.BN("900000000000000000"), tokenMaxB: new anchor.BN("900000000000000000"),
      whirlpool: poolPda.publicKey, positionAuthority: payer.publicKey, position: pp.publicKey, positionTokenAccount: pta,
      tokenMintA: base.publicKey, tokenMintB: quote.publicKey,
      tokenOwnerAccountA: ataA, tokenOwnerAccountB: ataB, tokenVaultA: vA.publicKey, tokenVaultB: vB.publicKey,
      tokenProgramA: TOKEN_2022_PROGRAM_ID, tokenProgramB: TOKEN_PROGRAM_ID,
      tokenTransferHookAccountsA: hookAccounts.length ? hookAccounts : undefined,
      tickArrayLower: arrFor(lo), tickArrayUpper: arrFor(hi === 640 ? 0 : hi),
    }).instructions, [], `liquidity ${lo}..${hi}`);
    if (r) liqCU.push(Number((r as any).computeUnitsConsumed()));
  }

  return { base, quote, ataA, ataB, vA, vB, poolPda, hookAccounts, liqCU };
}

function swapCU(p: ReturnType<typeof buildPool>, amount: bigint, limitTick: number, arrays: number[], label: string) {
  const oracle = PDAUtil.getOracle(ORCA_WHIRLPOOL_PROGRAM_ID, p.poolPda.publicKey);
  const ta = arrays.map(s => PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, p.poolPda.publicKey, s).publicKey);
  const r = send(WhirlpoolIx.swapV2Ix(ctx.program, {
    amount: new anchor.BN(amount.toString()), otherAmountThreshold: new anchor.BN(0),
    sqrtPriceLimit: PriceMath.tickIndexToSqrtPriceX64(limitTick),
    amountSpecifiedIsInput: true, aToB: true,
    tickArray0: ta[0], tickArray1: ta[1], tickArray2: ta[2],
    whirlpool: p.poolPda.publicKey, tokenMintA: p.base.publicKey, tokenMintB: p.quote.publicKey,
    tokenOwnerAccountA: p.ataA, tokenOwnerAccountB: p.ataB,
    tokenVaultA: p.vA.publicKey, tokenVaultB: p.vB.publicKey,
    tokenProgramA: TOKEN_2022_PROGRAM_ID, tokenProgramB: TOKEN_PROGRAM_ID,
    tokenTransferHookAccountsA: p.hookAccounts.length ? p.hookAccounts : undefined,
    oracle: oracle.publicKey, tokenAuthority: payer.publicKey,
  }).instructions, [], label);
  return r ? Number((r as any).computeUnitsConsumed()) : NaN;
}

console.log("building UNHOOKED pool (baseline)...");
const plain = buildPool(false);
console.log("building HOOKED pool...");
const hooked = buildPool(true);

const rows: [string, number, number][] = [];
const arrays0 = [0, -TPA, -2 * TPA];

rows.push(["increaseLiquidityV2 (median)",
  plain.liqCU.sort((a,b)=>a-b)[Math.floor(plain.liqCU.length/2)],
  hooked.liqCU.sort((a,b)=>a-b)[Math.floor(hooked.liqCU.length/2)]]);

rows.push(["swapV2 small (within 1 tick array)",
  swapCU(plain, 1_000_000n, -600, arrays0, "plain small"),
  swapCU(hooked, 1_000_000n, -600, arrays0, "hooked small")]);

rows.push(["swapV2 large (crosses ~3 tick arrays)",
  swapCU(plain, 500_000_000_000n, -9000, arrays0, "plain large"),
  swapCU(hooked, 500_000_000_000n, -9000, arrays0, "hooked large")]);

// --- two-hop: the shape Jupiter uses when there is no direct pair ---
console.log("building two-hop route (hooked -> mid -> end)...");
function twoHop(hookedLeg: boolean) {
  const mid = Keypair.generate();
  const qLen = getMintLen([]);
  send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mid.publicKey, space: qLen,
      lamports: Number(svm.minimumBalanceForRentExemption(BigInt(qLen))), programId: TOKEN_PROGRAM_ID }),
    createInitializeMintInstruction(mid.publicKey, 9, payer.publicKey, null, TOKEN_PROGRAM_ID),
  ], [mid], "mid mint");
  const midAta = getAssociatedTokenAddressSync(mid.publicKey, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  send([
    createAssociatedTokenAccountInstruction(payer.publicKey, midAta, payer.publicKey, mid.publicKey, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createMintToInstruction(mid.publicKey, midAta, payer.publicKey, 10n ** 18n, [], TOKEN_PROGRAM_ID),
  ], [], "mid ata");

  const one = buildPool(hookedLeg, mid);   // base(hooked?) / mid
  const two = buildPool(false, mid);        // base(plain)  / mid
  const oracle1 = PDAUtil.getOracle(ORCA_WHIRLPOOL_PROGRAM_ID, one.poolPda.publicKey);
  const oracle2 = PDAUtil.getOracle(ORCA_WHIRLPOOL_PROGRAM_ID, two.poolPda.publicKey);
  const ta = (p: any, s: number) => PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, p.poolPda.publicKey, s).publicKey;

  const r = send(WhirlpoolIx.twoHopSwapV2Ix(ctx.program, {
    amount: new anchor.BN(1_000_000), otherAmountThreshold: new anchor.BN(0),
    amountSpecifiedIsInput: true,
    aToBOne: true, aToBTwo: false,
    sqrtPriceLimitOne: PriceMath.tickIndexToSqrtPriceX64(-600),
    sqrtPriceLimitTwo: PriceMath.tickIndexToSqrtPriceX64(600),
    whirlpoolOne: one.poolPda.publicKey, whirlpoolTwo: two.poolPda.publicKey,
    tokenMintInput: one.base.publicKey, tokenMintIntermediate: mid.publicKey, tokenMintOutput: two.base.publicKey,
    tokenProgramInput: TOKEN_2022_PROGRAM_ID, tokenProgramIntermediate: TOKEN_PROGRAM_ID, tokenProgramOutput: TOKEN_2022_PROGRAM_ID,
    tokenOwnerAccountInput: one.ataA, tokenOwnerAccountOutput: two.ataA,
    tokenVaultOneInput: one.vA.publicKey, tokenVaultOneIntermediate: one.vB.publicKey,
    tokenVaultTwoIntermediate: two.vB.publicKey, tokenVaultTwoOutput: two.vA.publicKey,
    tokenTransferHookAccountsInput: one.hookAccounts.length ? one.hookAccounts : undefined,
    tokenTransferHookAccountsOutput: two.hookAccounts.length ? two.hookAccounts : undefined,
    tickArrayOne0: ta(one, 0), tickArrayOne1: ta(one, -TPA), tickArrayOne2: ta(one, -2 * TPA),
    tickArrayTwo0: ta(two, 0), tickArrayTwo1: ta(two, TPA), tickArrayTwo2: ta(two, TPA),
    oracleOne: oracle1.publicKey, oracleTwo: oracle2.publicKey,
    tokenAuthority: payer.publicKey,
  }).instructions, [], `twoHopSwapV2 ${hookedLeg ? "hooked" : "plain"}`);
  return r ? Number((r as any).computeUnitsConsumed()) : NaN;
}
rows.push(["twoHopSwapV2 (Jupiter-style route)", twoHop(false), twoHop(true)]);

console.log("\n" + "=".repeat(78));
console.log("COMPUTE UNITS".padEnd(40) + "no hook".padStart(11) + "with hook".padStart(13) + "delta".padStart(11));
console.log("=".repeat(78));
for (const [label, a, b] of rows) {
  const d = Number.isNaN(a) || Number.isNaN(b) ? "-" : `+${b - a}`;
  console.log(label.padEnd(40) + String(a).padStart(11) + String(b).padStart(13) + d.padStart(11));
}
console.log("=".repeat(78));
console.log("\ndefault per-transaction budget: 200,000 CU   |   maximum: 1,400,000 CU");
