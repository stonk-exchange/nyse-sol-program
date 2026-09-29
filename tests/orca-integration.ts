/**
 * End-to-end test against Orca's REAL mainnet Whirlpool program.
 *
 * The program binary and Orca's live WhirlpoolsConfig are pulled from mainnet
 * (scripts/fetch-orca-fixtures.sh) and loaded into LiteSVM. The config's
 * authorities are repointed at a test keypair so we can issue ourselves a
 * TokenBadge; nothing else about Orca's program or config is modified.
 *
 * This answers two questions that inspection cannot:
 *   1. Does Orca accept our hooked mint, and is the TokenBadge the only gate?
 *   2. Do real Whirlpool swaps respect NYSE hours, failing with our own errors?
 *
 *   ./scripts/fetch-orca-fixtures.sh && npm run test:orca
 */
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  Keypair, PublicKey, Connection, SystemProgram, Transaction, TransactionInstruction, AccountMeta,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import {
  WhirlpoolContext, WhirlpoolIx, ORCA_WHIRLPOOL_PROGRAM_ID, PDAUtil, PriceMath,
} from "@orca-so/whirlpools-sdk";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType,
  getMintLen, createInitializeMintInstruction, createInitializeTransferHookInstruction,
  createAssociatedTokenAccountInstruction, createMintToInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";
import { expect } from "chai";
import * as fs from "fs";

const HOOK = new PublicKey("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");
const HOOK_SO = "target/deploy/nyse_token_hook.so";
const ORCA_SO = "fixtures/orca/whirlpool.so";
const ORCA_CFG = "fixtures/orca/config.json";

/** Whirlpool rejects a clock that moves backwards, so these only go forward. */
const OPEN = 1_790_607_600n; // 2026-09-28 Mon 11:00 ET
const AFTER_HOURS = 1_790_627_400n; // 2026-09-28 Mon 16:30 ET
const WEEKEND = 1_791_039_600n; // 2026-10-03 Sat 11:00 ET
const REOPEN = 1_791_212_400n; // 2026-10-05 Mon 11:00 ET

/** Our NyseError codes, and Orca's badge rejection. */
const ERR = { WEEKEND: 6000, AFTER_HOURS: 6003, UNSUPPORTED_TOKEN_MINT: 6047 };

const TICK_SPACING = 64;
const TICKS_PER_ARRAY = 88 * TICK_SPACING;

const haveFixtures = fs.existsSync(ORCA_SO) && fs.existsSync(ORCA_CFG) && fs.existsSync(HOOK_SO);

(haveFixtures ? describe : describe.skip)("Orca Whirlpools (real mainnet program)", function () {
  this.timeout(120_000);

  let svm: LiteSVM;
  let payer: Keypair;
  let ctx: WhirlpoolContext;
  let config: PublicKey;
  let hookedMint: Keypair;
  let quoteMint: Keypair;
  let hookAccounts: AccountMeta[];
  let ataA: PublicKey;
  let ataB: PublicKey;
  let pool: PublicKey;
  let vaultA: Keypair;
  let vaultB: Keypair;
  let badgeA: { publicKey: PublicKey; bump: number };
  let badgeB: PublicKey;
  let feeTierKey: PublicKey;

  const setClock = (ts: bigint) => {
    const c = svm.getClock();
    c.unixTimestamp = ts;
    svm.setClock(c);
  };

  function send(ixs: TransactionInstruction[], signers: Keypair[]) {
    svm.expireBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = payer.publicKey;
    ixs.forEach((i) => tx.add(i));
    tx.sign(payer, ...signers);
    return svm.sendTransaction(tx);
  }

  function ok(ixs: TransactionInstruction[], signers: Keypair[], label: string) {
    const r = send(ixs, signers);
    if (r instanceof FailedTransactionMetadata) {
      const logs = (r.meta?.().logs?.() ?? []).slice(-4).join("\n      ");
      throw new Error(`${label} failed: ${JSON.stringify(r.err())}\n      ${logs}`);
    }
    return r;
  }

  function expectCustomError(r: ReturnType<typeof send>, code: number, label: string) {
    expect(r instanceof FailedTransactionMetadata, `${label}: expected failure`).to.be.true;
    // litesvm's error object serialises to {} via JSON.stringify; the custom
    // code only shows up in toString().
    const rendered = (r as FailedTransactionMetadata).err().toString();
    expect(
      new RegExp(`\\b${code}\\b`).test(rendered),
      `${label}: expected custom error ${code}, got ${rendered}`
    ).to.be.true;
  }

  function tokenBalance(account: PublicKey): bigint {
    const a = svm.getAccount(account);
    if (!a) throw new Error("missing token account");
    return Buffer.from(a.data).readBigUInt64LE(64);
  }

  function swapIxs(): TransactionInstruction[] {
    const oracle = PDAUtil.getOracle(ORCA_WHIRLPOOL_PROGRAM_ID, pool);
    const ta0 = PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, pool, 0).publicKey;
    const taN = PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, pool, -TICKS_PER_ARRAY).publicKey;
    return WhirlpoolIx.swapV2Ix(ctx.program, {
      amount: new anchor.BN(1_000_000),
      otherAmountThreshold: new anchor.BN(0),
      sqrtPriceLimit: PriceMath.tickIndexToSqrtPriceX64(-600),
      amountSpecifiedIsInput: true,
      aToB: true,
      tickArray0: ta0, tickArray1: taN, tickArray2: taN,
      whirlpool: pool,
      tokenMintA: hookedMint.publicKey, tokenMintB: quoteMint.publicKey,
      tokenOwnerAccountA: ataA, tokenOwnerAccountB: ataB,
      tokenVaultA: vaultA.publicKey, tokenVaultB: vaultB.publicKey,
      tokenProgramA: TOKEN_2022_PROGRAM_ID, tokenProgramB: TOKEN_PROGRAM_ID,
      tokenTransferHookAccountsA: hookAccounts,
      oracle: oracle.publicKey,
      tokenAuthority: payer.publicKey,
    }).instructions;
  }

  before(() => {
    svm = new LiteSVM().withBuiltins().withSplPrograms().withSysvars();
    svm.addProgramFromFile(ORCA_WHIRLPOOL_PROGRAM_ID, ORCA_SO);
    svm.addProgramFromFile(HOOK, HOOK_SO);

    payer = Keypair.generate();
    svm.airdrop(payer.publicKey, 10_000n * 1_000_000_000n);
    setClock(OPEN);

    // Clone Orca's live config, repointing only its authorities at the test
    // keypair so we can act as the TokenBadge authority.
    const saved = JSON.parse(fs.readFileSync(ORCA_CFG, "utf8"));
    config = new PublicKey(saved.config.pk);
    const clone = (rec: any, patches: [number, PublicKey][]) => {
      const data = Buffer.from(rec.data, "base64");
      for (const [off, pk] of patches) pk.toBuffer().copy(data, off);
      svm.setAccount(new PublicKey(rec.pk), {
        lamports: rec.lamports, data, owner: new PublicKey(rec.owner),
        executable: false, rentEpoch: 0,
      });
    };
    // WhirlpoolsConfig:   disc(8) feeAuthority(32) collectProtocolFees(32) rewardSuper(32)
    clone(saved.config, [[8, payer.publicKey], [40, payer.publicKey], [72, payer.publicKey]]);
    // ConfigExtension:    disc(8) config(32) configExtAuthority(32) tokenBadgeAuthority(32)
    clone(saved.ext, [[40, payer.publicKey], [72, payer.publicKey]]);
    clone(saved.feeTier, []);
    feeTierKey = new PublicKey(saved.feeTier.pk);

    const wallet = {
      publicKey: payer.publicKey,
      signTransaction: async (t: any) => t,
      signAllTransactions: async (t: any) => t,
    };
    const provider = new anchor.AnchorProvider(
      new Connection("http://127.0.0.1:8899"), wallet as any, {}
    );
    ctx = WhirlpoolContext.withProvider(provider, undefined, undefined, undefined, ORCA_WHIRLPOOL_PROGRAM_ID);

    // Orca requires mintA < mintB.
    quoteMint = Keypair.generate();
    do { hookedMint = Keypair.generate(); }
    while (Buffer.compare(hookedMint.publicKey.toBuffer(), quoteMint.publicKey.toBuffer()) >= 0);

    const [extraMetas] = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), hookedMint.publicKey.toBuffer()], HOOK
    );
    // Our hook resolves zero extra accounts, so Token-2022 wants exactly these.
    hookAccounts = [
      { pubkey: HOOK, isSigner: false, isWritable: false },
      { pubkey: extraMetas, isSigner: false, isWritable: false },
    ];

    const mintLen = getMintLen([ExtensionType.TransferHook]);
    ok([
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: hookedMint.publicKey, space: mintLen,
        lamports: Number(svm.minimumBalanceForRentExemption(BigInt(mintLen))),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(hookedMint.publicKey, payer.publicKey, HOOK, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(hookedMint.publicKey, 9, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ], [hookedMint], "create hooked mint");

    ok([{
      programId: HOOK,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: extraMetas, isSigner: false, isWritable: true },
        { pubkey: hookedMint.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: createHash("sha256").update("global:initialize_extra_account_meta_list").digest().subarray(0, 8),
    } as TransactionInstruction], [], "hook validation state");

    const qLen = getMintLen([]);
    ok([
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: quoteMint.publicKey, space: qLen,
        lamports: Number(svm.minimumBalanceForRentExemption(BigInt(qLen))),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction(quoteMint.publicKey, 9, payer.publicKey, null, TOKEN_PROGRAM_ID),
    ], [quoteMint], "create quote mint");

    ataA = getAssociatedTokenAddressSync(hookedMint.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    ataB = getAssociatedTokenAddressSync(quoteMint.publicKey, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    ok([
      createAssociatedTokenAccountInstruction(payer.publicKey, ataA, payer.publicKey, hookedMint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountInstruction(payer.publicKey, ataB, payer.publicKey, quoteMint.publicKey, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      createMintToInstruction(hookedMint.publicKey, ataA, payer.publicKey, 1_000_000_000_000n, [], TOKEN_2022_PROGRAM_ID),
      createMintToInstruction(quoteMint.publicKey, ataB, payer.publicKey, 1_000_000_000_000n, [], TOKEN_PROGRAM_ID),
    ], [], "token accounts and supply");

    badgeA = PDAUtil.getTokenBadge(ORCA_WHIRLPOOL_PROGRAM_ID, config, hookedMint.publicKey);
    badgeB = PDAUtil.getTokenBadge(ORCA_WHIRLPOOL_PROGRAM_ID, config, quoteMint.publicKey).publicKey;
    pool = PDAUtil.getWhirlpool(ORCA_WHIRLPOOL_PROGRAM_ID, config, hookedMint.publicKey, quoteMint.publicKey, TICK_SPACING).publicKey;
  });

  function initPoolIxs(vA: Keypair, vB: Keypair) {
    return WhirlpoolIx.initializePoolV2Ix(ctx.program, {
      whirlpoolsConfig: config,
      tokenMintA: hookedMint.publicKey, tokenMintB: quoteMint.publicKey,
      tokenBadgeA: badgeA.publicKey, tokenBadgeB: badgeB,
      tokenProgramA: TOKEN_2022_PROGRAM_ID, tokenProgramB: TOKEN_PROGRAM_ID,
      funder: payer.publicKey,
      whirlpoolPda: PDAUtil.getWhirlpool(ORCA_WHIRLPOOL_PROGRAM_ID, config, hookedMint.publicKey, quoteMint.publicKey, TICK_SPACING),
      tokenVaultAKeypair: vA, tokenVaultBKeypair: vB,
      feeTierKey, tickSpacing: TICK_SPACING,
      initSqrtPrice: PriceMath.tickIndexToSqrtPriceX64(0),
    }).instructions;
  }

  describe("the TokenBadge is the gate", () => {
    it("rejects the hooked mint without a badge", () => {
      const vA = Keypair.generate();
      const vB = Keypair.generate();
      const r = send(initPoolIxs(vA, vB), [vA, vB]);
      expectCustomError(r, ERR.UNSUPPORTED_TOKEN_MINT, "initializePoolV2 without badge");
    });

    it("accepts it once Orca issues a badge", () => {
      ok(WhirlpoolIx.initializeTokenBadgeIx(ctx.program, {
        whirlpoolsConfig: config,
        whirlpoolsConfigExtension: PDAUtil.getConfigExtension(ORCA_WHIRLPOOL_PROGRAM_ID, config).publicKey,
        tokenBadgeAuthority: payer.publicKey,
        tokenMint: hookedMint.publicKey,
        tokenBadgePda: badgeA,
        funder: payer.publicKey,
      }).instructions, [], "initializeTokenBadge");

      vaultA = Keypair.generate();
      vaultB = Keypair.generate();
      ok(initPoolIxs(vaultA, vaultB), [vaultA, vaultB], "initializePoolV2 with badge");
      expect(svm.getAccount(pool), "pool created").to.not.be.null;
    });
  });

  describe("liquidity", () => {
    it("accepts liquidity during market hours", () => {
      setClock(OPEN);
      for (const start of [-TICKS_PER_ARRAY, 0, TICKS_PER_ARRAY]) {
        ok(WhirlpoolIx.initTickArrayIx(ctx.program, {
          whirlpool: pool,
          tickArrayPda: PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, pool, start),
          startTick: start, funder: payer.publicKey,
        }).instructions, [], `initTickArray ${start}`);
      }

      const positionMint = Keypair.generate();
      const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMint.publicKey);
      const positionTokenAccount = getAssociatedTokenAddressSync(
        positionMint.publicKey, payer.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      );
      ok(WhirlpoolIx.openPositionIx(ctx.program, {
        funder: payer.publicKey, owner: payer.publicKey, positionPda,
        positionMintAddress: positionMint.publicKey, positionTokenAccount,
        whirlpool: pool, tickLowerIndex: -640, tickUpperIndex: 640,
      }).instructions, [positionMint], "openPosition");

      ok(WhirlpoolIx.increaseLiquidityV2Ix(ctx.program, {
        liquidityAmount: new anchor.BN(1_000_000_000),
        tokenMaxA: new anchor.BN(500_000_000_000), tokenMaxB: new anchor.BN(500_000_000_000),
        whirlpool: pool, positionAuthority: payer.publicKey,
        position: positionPda.publicKey, positionTokenAccount,
        tokenMintA: hookedMint.publicKey, tokenMintB: quoteMint.publicKey,
        tokenOwnerAccountA: ataA, tokenOwnerAccountB: ataB,
        tokenVaultA: vaultA.publicKey, tokenVaultB: vaultB.publicKey,
        tokenProgramA: TOKEN_2022_PROGRAM_ID, tokenProgramB: TOKEN_PROGRAM_ID,
        tokenTransferHookAccountsA: hookAccounts,
        tickArrayLower: PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, pool, -TICKS_PER_ARRAY).publicKey,
        tickArrayUpper: PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, pool, 0).publicKey,
      }).instructions, [], "increaseLiquidityV2");

      // Without this the swap tests below would pass vacuously on an empty pool.
      expect(tokenBalance(vaultA.publicKey) > 0n, "vault A funded with hooked tokens").to.be.true;
    });
  });

  describe("swaps respect NYSE hours", () => {
    it("allows a swap during the session", () => {
      setClock(OPEN);
      const before = tokenBalance(ataB);
      const r = ok(swapIxs(), [], "swapV2 in session");
      expect(tokenBalance(ataB) > before, "received quote tokens").to.be.true;
      console.log(`        [CU] Whirlpool swap incl. hook: ${(r as any).computeUnitsConsumed()}`);
    });

    it("blocks a swap after the close with MarketClosedAfterHours", () => {
      setClock(AFTER_HOURS);
      const before = tokenBalance(ataB);
      expectCustomError(send(swapIxs(), []), ERR.AFTER_HOURS, "swapV2 after hours");
      expect(tokenBalance(ataB), "no tokens moved").to.equal(before);
    });

    it("blocks a swap on a Saturday with MarketClosedWeekend", () => {
      setClock(WEEKEND);
      const before = tokenBalance(ataB);
      expectCustomError(send(swapIxs(), []), ERR.WEEKEND, "swapV2 on Saturday");
      expect(tokenBalance(ataB), "no tokens moved").to.equal(before);
    });

    it("allows swaps again when the market reopens", () => {
      setClock(REOPEN);
      const before = tokenBalance(ataB);
      ok(swapIxs(), [], "swapV2 after reopen");
      expect(tokenBalance(ataB) > before, "received quote tokens").to.be.true;
    });
  });
});
