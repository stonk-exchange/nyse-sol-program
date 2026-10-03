/**
 * Integration tests for the NYSE transfer hook.
 *
 * These run against LiteSVM with a controlled clock, so every market state is
 * exercised deterministically -- a real Token-2022 transfer is attempted at each
 * timestamp and we assert on the actual on-chain outcome. Timestamps are exact
 * UTC epochs for the stated Eastern wall-clock time, derived from the IANA tz
 * database (see scripts/gen_market_table.py).
 */
import { LiteSVM, Clock, FailedTransactionMetadata } from "litesvm";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createBurnInstruction,
  createApproveInstruction,
  createRevokeInstruction,
  createSetAuthorityInstruction,
  createUpdateTransferHookInstruction,
  AuthorityType,
  unpackMint,
  getTransferHook,
  getExtensionData,
  createInitializeMetadataPointerInstruction,
  LENGTH_SIZE,
  TYPE_SIZE,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import {
  pack,
  unpack as unpackMetadata,
  createInitializeInstruction as createInitializeMetadataInstruction,
  createUpdateAuthorityInstruction as createUpdateMetadataAuthorityInstruction,
  type TokenMetadata,
} from "@solana/spl-token-metadata";
import { createHash } from "crypto";
import { market } from "../scripts/markets/presets";
import {
  initializeScheduleIx, transferHookAccounts, extraAccountMetasAddress, scheduleAddress,
  initializeRegistryIx, registerMarketIx, registryAddress, marketAddress, scheduleHash,
} from "../scripts/markets/hook";
import { expect } from "chai";
import * as fs from "fs";

const PROGRAM_ID = new PublicKey("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");
const SO_PATH = "target/deploy/nyse_token_hook.so";
const DECIMALS = 9;

/** Anchor error codes, in declaration order from NyseError. */
/** HookError, in declaration order. The evaluator has one "closed" code now:
 *  weekends, pre-market and after-hours are all MarketClosed. */
const ERR = {
  CLOSED: 6000,
  HOLIDAY: 6001,
  NOT_TRANSFERRING: 6002,
};
const NYSE = market("nyse");

/** Exact UTC epochs for the stated Eastern wall-clock times. */
const T = {
  openRegular: { ts: 1790607600n, label: "2026-09-28 Mon 11:00 ET" },
  weekend: { ts: 1790434800n, label: "2026-09-26 Sat 11:00 ET" },
  holidayChristmas: { ts: 1798214400n, label: "2026-12-25 Fri 11:00 ET" },
  preMarket: { ts: 1790600400n, label: "2026-09-28 Mon 09:00 ET" },
  afterHours: { ts: 1790627400n, label: "2026-09-28 Mon 16:30 ET" },
  openAtBell: { ts: 1790602200n, label: "2026-09-28 Mon 09:30 ET" },
  lastMinute: { ts: 1790625540n, label: "2026-09-28 Mon 15:59 ET" },
  // NYSE closes at 13:00 ET on these days; we deliberately trade a full session.
  nyseHalfDayAfternoon: { ts: 1795806000n, label: "2026-11-27 Fri 14:00 ET (NYSE half-day)" },
  nyseHalfDayClose: { ts: 1798145700n, label: "2026-12-24 Thu 15:55 ET (NYSE half-day)" },
  regressionDec11: { ts: 1797004800n, label: "2026-12-11 Fri 11:00 ET" },
  regressionOct20: { ts: 1792503900n, label: "2026-10-20 Tue 09:45 ET" },
};

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

describe("NYSE transfer hook", () => {
  let svm: LiteSVM;
  let payer: Keypair;
  let mint: Keypair;
  let extraMetas: PublicKey;
  let source: PublicKey;
  let destination: PublicKey;
  let recipient: Keypair;

  /**
   * Assert a failure is the given Anchor custom error. litesvm renders these as
   * an InstructionError with a Custom code, so we match the code precisely
   * rather than substring-matching the whole error string.
   */
  function expectCustomError(
    result: FailedTransactionMetadata,
    code: number,
    label: string
  ) {
    const err = JSON.stringify(result.err());
    const rendered = `${err} ${result.err().toString()}`;
    expect(
      new RegExp(`\\b${code}\\b`).test(rendered),
      `${label}: expected custom error ${code}, got ${rendered}`
    ).to.be.true;
  }

  function setClock(unixTimestamp: bigint) {
    const clock = svm.getClock();
    clock.unixTimestamp = unixTimestamp;
    svm.setClock(clock);
  }

  function send(ixs: TransactionInstruction[], signers: Keypair[]) {
    // Each transaction needs a distinct blockhash, otherwise two identical
    // transfers produce the same signature and the second is rejected as a
    // duplicate rather than reaching the hook.
    svm.expireBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = payer.publicKey;
    ixs.forEach((ix) => tx.add(ix));
    tx.sign(...signers);
    return svm.sendTransaction(tx);
  }

  /**
   * TransferChecked with the transfer-hook accounts appended. This hook resolves
   * zero extra accounts, so Token-2022 expects exactly the hook program followed
   * by the validation-state PDA -- matching what
   * `addExtraAccountMetasForExecute` appends in @solana/spl-token.
   */
  function transferIx(amount: bigint): TransactionInstruction {
    const ix = createTransferCheckedInstruction(
      source,
      mint.publicKey,
      destination,
      payer.publicKey,
      amount,
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    ix.keys.push(...transferHookAccounts(mint.publicKey));
    return ix;
  }

  function balances() {
    const src = getAccount(
      { getAccountInfo: (k: PublicKey) => svm.getAccount(k) } as any,
      source,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    return src;
  }

  function rawBalance(account: PublicKey): bigint {
    const info = svm.getAccount(account);
    if (!info) throw new Error("missing token account");
    // SPL token account layout: amount is a u64 at offset 64.
    return Buffer.from(info.data).readBigUInt64LE(64);
  }

  /** Assert the transfer lands and moves the tokens. */
  function expectTransferAllowed(at: { ts: bigint; label: string }) {
    setClock(at.ts);
    const before = rawBalance(destination);
    const result = send([transferIx(1_000n)], [payer]);
    expect(
      result instanceof FailedTransactionMetadata,
      `${at.label}: expected transfer to succeed, got ${
        result instanceof FailedTransactionMetadata ? result.err().toString() : ""
      }`
    ).to.be.false;
    expect(rawBalance(destination) - before).to.equal(1_000n, `${at.label}: balance did not move`);
  }

  /** Assert the transfer is rejected with the given Anchor error code, and nothing moves. */
  function expectTransferBlocked(at: { ts: bigint; label: string }, code: number) {
    setClock(at.ts);
    const srcBefore = rawBalance(source);
    const dstBefore = rawBalance(destination);
    const result = send([transferIx(1_000n)], [payer]);
    expect(result instanceof FailedTransactionMetadata, `${at.label}: expected transfer to fail`).to
      .be.true;
    expectCustomError(result as FailedTransactionMetadata, code, at.label);
    expect(rawBalance(source), `${at.label}: source balance changed`).to.equal(srcBefore);
    expect(rawBalance(destination), `${at.label}: destination balance changed`).to.equal(dstBefore);
  }

  before(() => {
    expect(fs.existsSync(SO_PATH), `build the program first: anchor build`).to.be.true;

    svm = new LiteSVM().withBuiltins().withSplPrograms().withSysvars();
    svm.addProgramFromFile(PROGRAM_ID, SO_PATH);

    payer = Keypair.generate();
    recipient = Keypair.generate();
    mint = Keypair.generate();
    svm.airdrop(payer.publicKey, 100_000_000_000n);

    // A time when the market is open, so setup transfers are not blocked.
    setClock(T.openRegular.ts);

    [extraMetas] = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
      PROGRAM_ID
    );

    // 1. Create the Token-2022 mint with the transfer hook extension.
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const createMint = send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space: mintLen,
          lamports: Number(svm.minimumBalanceForRentExemption(BigInt(mintLen))),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeTransferHookInstruction(
          mint.publicKey,
          PublicKey.default,
          PROGRAM_ID,
          TOKEN_2022_PROGRAM_ID
        ),
        createInitializeMintInstruction(
          mint.publicKey,
          DECIMALS,
          payer.publicKey,
          null,
          TOKEN_2022_PROGRAM_ID
        ),
      ],
      [payer, mint]
    );
    expect(createMint instanceof FailedTransactionMetadata, "mint creation failed").to.be.false;

    // 2. Initialize the hook's extra-account-meta list.
    const initMetas = send(
      [
        new TransactionInstruction(initializeScheduleIx(mint.publicKey, payer.publicKey, NYSE)),
      ],
      [payer]
    );
    expect(
      initMetas instanceof FailedTransactionMetadata,
      `extra account meta init failed: ${
        initMetas instanceof FailedTransactionMetadata ? initMetas.err().toString() : ""
      }`
    ).to.be.false;

    // 3. Token accounts, and supply for the source.
    source = getAssociatedTokenAddressSync(
      mint.publicKey,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    destination = getAssociatedTokenAddressSync(
      mint.publicKey,
      recipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const setupAccounts = send(
      [
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          source,
          payer.publicKey,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ),
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          destination,
          recipient.publicKey,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        ),
        createMintToInstruction(
          mint.publicKey,
          source,
          payer.publicKey,
          1_000_000_000_000n,
          [],
          TOKEN_2022_PROGRAM_ID
        ),
      ],
      [payer]
    );
    expect(
      setupAccounts instanceof FailedTransactionMetadata,
      `account setup failed: ${
        setupAccounts instanceof FailedTransactionMetadata
          ? setupAccounts.err().toString()
          : ""
      }`
    ).to.be.false;
  });

  describe("transfers during the regular session", () => {
    it("allows a mid-session transfer", () => {
      expectTransferAllowed(T.openRegular);
    });

    it("allows a transfer at the opening bell (09:30 ET)", () => {
      expectTransferAllowed(T.openAtBell);
    });

    it("allows a transfer in the closing minute (15:59 ET)", () => {
      expectTransferAllowed(T.lastMinute);
    });
  });

  describe("transfers outside the session", () => {
    it("blocks weekends", () => {
      expectTransferBlocked(T.weekend, ERR.CLOSED);
    });

    it("blocks exchange holidays", () => {
      expectTransferBlocked(T.holidayChristmas, ERR.HOLIDAY);
    });

    it("blocks pre-market (09:00 ET)", () => {
      expectTransferBlocked(T.preMarket, ERR.CLOSED);
    });

    it("blocks after hours (16:30 ET)", () => {
      expectTransferBlocked(T.afterHours, ERR.CLOSED);
    });
  });

  describe("NYSE half-days are deliberately not enforced", () => {
    it("still allows trading at 14:00 ET on the Friday after Thanksgiving", () => {
      expectTransferAllowed(T.nyseHalfDayAfternoon);
    });

    it("still allows trading at 15:55 ET on Christmas Eve", () => {
      expectTransferAllowed(T.nyseHalfDayClose);
    });
  });

  describe("regressions from the 365-day-year calendar bug", () => {
    it("allows trading on 2026-12-11, which the old code blocked as Christmas", () => {
      expectTransferAllowed(T.regressionDec11);
    });

    it("allows 09:45 ET on 2026-10-20, when the old DST check shifted the window", () => {
      expectTransferAllowed(T.regressionOct20);
    });
  });

  // What the hook does NOT gate. Token-2022 only invokes a transfer hook from
  // Transfer/TransferChecked, so any other operation on the mint is unaffected
  // by market hours. These tests document that boundary rather than assert a
  // desired behaviour -- if a future Token-2022 version changes it, we want to
  // know.
  describe("operations the hook does not gate", () => {
    it("allows burning while the market is closed", () => {
      setClock(T.weekend.ts);
      const before = rawBalance(source);
      const result = send(
        [
          createBurnInstruction(
            source,
            mint.publicKey,
            payer.publicKey,
            500n,
            [],
            TOKEN_2022_PROGRAM_ID
          ),
        ],
        [payer]
      );
      expect(result instanceof FailedTransactionMetadata, "burn should not be gated").to.be.false;
      expect(before - rawBalance(source)).to.equal(500n);
    });

    it("allows minting while the market is closed", () => {
      setClock(T.weekend.ts);
      const before = rawBalance(source);
      const result = send(
        [
          createMintToInstruction(
            mint.publicKey,
            source,
            payer.publicKey,
            500n,
            [],
            TOKEN_2022_PROGRAM_ID
          ),
        ],
        [payer]
      );
      expect(result instanceof FailedTransactionMetadata, "mint should not be gated").to.be.false;
      expect(rawBalance(source) - before).to.equal(500n);
    });

    it("allows approving a delegate while the market is closed", () => {
      setClock(T.weekend.ts);
      const result = send(
        [
          createApproveInstruction(
            source,
            recipient.publicKey,
            payer.publicKey,
            1_000n,
            [],
            TOKEN_2022_PROGRAM_ID
          ),
        ],
        [payer]
      );
      expect(result instanceof FailedTransactionMetadata, "approve should not be gated").to.be
        .false;
    });
  });

  // The source_token constraint used to be `token::authority = owner`, which
  // broke delegated transfers because Token-2022 passes the transfer AUTHORITY
  // in that position, not the account owner. These pin the fix.
  describe("delegated transfers", () => {
    let delegate: Keypair;

    before(() => {
      delegate = Keypair.generate();
      svm.airdrop(delegate.publicKey, 1_000_000_000n);
      setClock(T.openRegular.ts);
      const approve = send(
        [
          createApproveInstruction(
            source, delegate.publicKey, payer.publicKey, 1_000_000n, [], TOKEN_2022_PROGRAM_ID
          ),
        ],
        [payer]
      );
      expect(approve instanceof FailedTransactionMetadata, "approve failed").to.be.false;
    });

    function delegatedTransfer(amount: bigint) {
      const ix = createTransferCheckedInstruction(
        source, mint.publicKey, destination, delegate.publicKey, amount, DECIMALS, [], TOKEN_2022_PROGRAM_ID
      );
      ix.keys.push(...transferHookAccounts(mint.publicKey));
      svm.expireBlockhash();
      const tx = new Transaction();
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = payer.publicKey;
      tx.add(ix);
      tx.sign(payer, delegate);
      return svm.sendTransaction(tx);
    }

    it("allows a delegate to transfer during market hours", () => {
      setClock(T.openRegular.ts);
      const before = rawBalance(destination);
      const r = delegatedTransfer(1_000n);
      expect(
        r instanceof FailedTransactionMetadata,
        `delegated transfer should succeed, got ${
          r instanceof FailedTransactionMetadata ? r.err().toString() : ""
        }`
      ).to.be.false;
      expect(rawBalance(destination) - before).to.equal(1_000n);
    });

    it("blocks a delegate outside market hours", () => {
      setClock(T.weekend.ts);
      const before = rawBalance(destination);
      expectCustomError(delegatedTransfer(1_000n) as FailedTransactionMetadata, ERR.CLOSED, "delegated weekend transfer");
      expect(rawBalance(destination)).to.equal(before);
    });
  });

  // The session boundaries are inclusive at the open and exclusive at the
  // close, to the second.
  describe("session boundaries, to the second", () => {
    const cases: [string, bigint, number | null][] = [
      ["09:29:59 ET", 1_790_602_199n, ERR.CLOSED],
      ["09:30:00 ET", 1_790_602_200n, null],
      ["15:59:59 ET", 1_790_625_599n, null],
      ["16:00:00 ET", 1_790_625_600n, ERR.CLOSED],
    ];

    for (const [label, ts, code] of cases) {
      it(`${label} is ${code === null ? "open" : "closed"}`, () => {
        setClock(ts);
        const before = rawBalance(destination);
        const r = send([transferIx(1_000n)], [payer]);
        if (code === null) {
          expect(
            r instanceof FailedTransactionMetadata,
            `${label}: expected open, got ${
              r instanceof FailedTransactionMetadata ? r.err().toString() : ""
            }`
          ).to.be.false;
          expect(rawBalance(destination) - before).to.equal(1_000n);
        } else {
          expectCustomError(r as FailedTransactionMetadata, code, label);
          expect(rawBalance(destination)).to.equal(before);
        }
      });
    }
  });

  describe("degenerate transfers", () => {
    it("blocks a zero-amount transfer outside market hours", () => {
      setClock(T.weekend.ts);
      const ix = createTransferCheckedInstruction(
        source, mint.publicKey, destination, payer.publicKey, 0n, DECIMALS, [], TOKEN_2022_PROGRAM_ID
      );
      ix.keys.push(...transferHookAccounts(mint.publicKey));
      expectCustomError(send([ix], [payer]) as FailedTransactionMetadata, ERR.CLOSED, "zero-amount weekend transfer");
    });

    // Token-2022 short-circuits a transfer whose source and destination are the
    // same account: it returns early WITHOUT invoking the transfer hook. This
    // is not a hole -- no value moves and no counterparty is involved -- but it
    // is the one transfer shape where the hook does not run, so it is pinned
    // here rather than assumed.
    it("self-transfers bypass the hook entirely, and move nothing", () => {
      setClock(T.weekend.ts);
      const before = rawBalance(source);
      const ix = createTransferCheckedInstruction(
        source, mint.publicKey, source, payer.publicKey, 1_000n, DECIMALS, [], TOKEN_2022_PROGRAM_ID
      );
      ix.keys.push(...transferHookAccounts(mint.publicKey));
      const r = send([ix], [payer]);

      expect(r instanceof FailedTransactionMetadata, "Token-2022 accepts it without calling the hook").to.be.false;
      expect(rawBalance(source), "balance is unchanged, so no value moved").to.equal(before);

      // Prove the hook really was not invoked, rather than invoked and passing.
      const logs = (r as any).meta?.().logs?.() ?? [];
      expect(
        logs.some((l: string) => l.includes(PROGRAM_ID.toBase58())),
        "hook program should not appear in the logs"
      ).to.be.false;
    });
  });

  describe("hook cannot be invoked outside a transfer", () => {
    it("rejects a direct Execute call", () => {
      setClock(T.openRegular.ts);
      // spl-transfer-hook-interface Execute discriminator, then a u64 amount.
      const data = Buffer.concat([
        createHash("sha256")
          .update("spl-transfer-hook-interface:execute")
          .digest()
          .subarray(0, 8),
        (() => {
          const b = Buffer.alloc(8);
          b.writeBigUInt64LE(1_000n);
          return b;
        })(),
      ]);
      const result = send(
        [
          new TransactionInstruction({
            programId: PROGRAM_ID,
            // Execute takes the five interface accounts, then the extras the
            // validation state resolves -- here, the schedule.
            keys: [
              { pubkey: source, isSigner: false, isWritable: false },
              { pubkey: mint.publicKey, isSigner: false, isWritable: false },
              { pubkey: destination, isSigner: false, isWritable: false },
              { pubkey: payer.publicKey, isSigner: false, isWritable: false },
              { pubkey: extraMetas, isSigner: false, isWritable: false },
              { pubkey: scheduleAddress(mint.publicKey), isSigner: false, isWritable: false },
            ],
            data,
          }),
        ],
        [payer]
      );
      expect(result instanceof FailedTransactionMetadata, "direct call should fail").to.be.true;
      expectCustomError(
        result as FailedTransactionMetadata,
        ERR.NOT_TRANSFERRING,
        "direct Execute call"
      );
    });
  });
});

/**
 * The launch configuration that actually makes the token non-tradeable outside
 * market hours with a fixed supply.
 *
 * Blocking transfers is only half of it: a mint whose authorities are still live
 * can be inflated, or have its hook repointed at a no-op program. These tests
 * build a mint the way it should be launched and assert that those doors are
 * shut permanently.
 */
describe("launch configuration: fixed supply, immutable hook and metadata", () => {
  const SUPPLY = 1_000_000_000_000_000n;
  const NAME = "STONKS";
  const SYMBOL = "STONKS";
  const URI = "https://example.com/stonks.json";

  let svm: LiteSVM;
  let payer: Keypair;
  let holder: Keypair;
  let mint: Keypair;
  let extraMetas: PublicKey;
  let source: PublicKey;
  let destination: PublicKey;

  function setClock(unixTimestamp: bigint) {
    const clock = svm.getClock();
    clock.unixTimestamp = unixTimestamp;
    svm.setClock(clock);
  }

  function send(ixs: TransactionInstruction[], signers: Keypair[]) {
    svm.expireBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = payer.publicKey;
    ixs.forEach((ix) => tx.add(ix));
    tx.sign(...signers);
    return svm.sendTransaction(tx);
  }

  function rawBalance(account: PublicKey): bigint {
    const info = svm.getAccount(account);
    if (!info) throw new Error("missing token account");
    return Buffer.from(info.data).readBigUInt64LE(64);
  }

  function transferIx(amount: bigint): TransactionInstruction {
    const ix = createTransferCheckedInstruction(
      source,
      mint.publicKey,
      destination,
      payer.publicKey,
      amount,
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    ix.keys.push(...transferHookAccounts(mint.publicKey));
    return ix;
  }

  function mintSupply(): bigint {
    const info = svm.getAccount(mint.publicKey);
    if (!info) throw new Error("missing mint");
    // Mint layout: supply is a u64 at offset 36.
    return Buffer.from(info.data).readBigUInt64LE(36);
  }

  before(() => {
    svm = new LiteSVM().withBuiltins().withSplPrograms().withSysvars();
    svm.addProgramFromFile(PROGRAM_ID, SO_PATH);

    payer = Keypair.generate();
    holder = Keypair.generate();
    mint = Keypair.generate();
    svm.airdrop(payer.publicKey, 100_000_000_000n);
    setClock(T.openRegular.ts);

    [extraMetas] = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
      PROGRAM_ID
    );

    const metadata: TokenMetadata = {
      updateAuthority: payer.publicKey,
      mint: mint.publicKey,
      name: NAME,
      symbol: SYMBOL,
      uri: URI,
      additionalMetadata: [],
    };
    // The account is sized for the fixed extensions but funded for the
    // variable-length metadata too, which InitializeTokenMetadata reallocs into.
    const mintLen = getMintLen([ExtensionType.TransferHook, ExtensionType.MetadataPointer]);
    const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
    const created = send(
      [
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space: mintLen,
          lamports: Number(svm.minimumBalanceForRentExemption(BigInt(mintLen + metadataLen))),
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeMetadataPointerInstruction(
          mint.publicKey,
          payer.publicKey,
          mint.publicKey,
          TOKEN_2022_PROGRAM_ID
        ),
        createInitializeTransferHookInstruction(
          mint.publicKey,
          PublicKey.default,
          PROGRAM_ID,
          TOKEN_2022_PROGRAM_ID
        ),
        // Freeze authority is null from the start: nothing should be able to
        // freeze or thaw individual holders.
        createInitializeMintInstruction(
          mint.publicKey,
          DECIMALS,
          payer.publicKey,
          null,
          TOKEN_2022_PROGRAM_ID
        ),
        createInitializeMetadataInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          metadata: mint.publicKey,
          updateAuthority: payer.publicKey,
          mint: mint.publicKey,
          mintAuthority: payer.publicKey,
          name: NAME,
          symbol: SYMBOL,
          uri: URI,
        }),
      ],
      [payer, mint]
    );
    expect(
      created instanceof FailedTransactionMetadata,
      `mint creation failed: ${
        created instanceof FailedTransactionMetadata ? created.err().toString() : ""
      }`
    ).to.be.false;

    const initMetas = send(
      [
        new TransactionInstruction(initializeScheduleIx(mint.publicKey, payer.publicKey, NYSE)),
      ],
      [payer]
    );
    expect(initMetas instanceof FailedTransactionMetadata, "meta init failed").to.be.false;

    source = getAssociatedTokenAddressSync(
      mint.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );
    destination = getAssociatedTokenAddressSync(
      mint.publicKey, holder.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Mint the entire fixed supply, then close the door behind us.
    const minted = send(
      [
        createAssociatedTokenAccountInstruction(
          payer.publicKey, source, payer.publicKey, mint.publicKey,
          TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        ),
        createAssociatedTokenAccountInstruction(
          payer.publicKey, destination, holder.publicKey, mint.publicKey,
          TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        ),
        createMintToInstruction(
          mint.publicKey, source, payer.publicKey, SUPPLY, [], TOKEN_2022_PROGRAM_ID
        ),
        // 1. Name, symbol and image can never be changed.
        createUpdateMetadataAuthorityInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          metadata: mint.publicKey,
          oldAuthority: payer.publicKey,
          newAuthority: null,
        }),
        // 2. No more tokens, ever.
        createSetAuthorityInstruction(
          mint.publicKey, payer.publicKey, AuthorityType.MintTokens, null, [],
          TOKEN_2022_PROGRAM_ID
        ),

      ],
      [payer]
    );
    expect(
      minted instanceof FailedTransactionMetadata,
      `supply mint + authority revocation failed: ${
        minted instanceof FailedTransactionMetadata ? minted.err().toString() : ""
      }`
    ).to.be.false;
  });

  // Pins how a revoked authority decodes, which is what scripts/launch-token.ts
  // checks after a real launch.
  it("reports every authority as revoked", () => {
    const info = svm.getAccount(mint.publicKey);
    if (!info) throw new Error("missing mint");
    const decoded = unpackMint(
      mint.publicKey,
      {
        ...info,
        data: Buffer.from(info.data),
        owner: new PublicKey(info.owner),
      } as any,
      TOKEN_2022_PROGRAM_ID
    );
    expect(decoded.mintAuthority, "mint authority").to.be.null;
    expect(decoded.freezeAuthority, "freeze authority").to.be.null;

    const hook = getTransferHook(decoded);
    expect(hook, "transfer hook extension present").to.not.be.null;
    expect(hook!.programId.equals(PROGRAM_ID), "hook still points at our program").to.be.true;
    // A revoked hook authority is the all-zeros pubkey, not null.
    expect(
      hook!.authority === null || hook!.authority.equals(PublicKey.default),
      `hook authority should be revoked, got ${hook!.authority?.toBase58()}`
    ).to.be.true;
  });

  // This is what wallets, explorers and DEX aggregators read off the mint.
  it("exposes name, symbol and uri on-chain", () => {
    const info = svm.getAccount(mint.publicKey);
    if (!info) throw new Error("missing mint");
    const decoded = unpackMint(
      mint.publicKey,
      { ...info, data: Buffer.from(info.data), owner: new PublicKey(info.owner) } as any,
      TOKEN_2022_PROGRAM_ID
    );
    const raw = getExtensionData(ExtensionType.TokenMetadata, decoded.tlvData);
    expect(raw, "TokenMetadata extension present on the mint").to.not.be.null;

    const meta = unpackMetadata(raw!);
    expect(meta.name).to.equal(NAME);
    expect(meta.symbol).to.equal(SYMBOL);
    expect(meta.uri).to.equal(URI);
    expect(meta.mint.equals(mint.publicKey), "metadata points at this mint").to.be.true;
  });

  it("cannot change the name, symbol or uri", () => {
    setClock(T.openRegular.ts);
    const result = send(
      [
        createUpdateMetadataAuthorityInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          metadata: mint.publicKey,
          oldAuthority: payer.publicKey,
          newAuthority: payer.publicKey,
        }),
      ],
      [payer]
    );
    expect(result instanceof FailedTransactionMetadata, "metadata should be immutable").to.be.true;
  });

  it("has the full supply minted", () => {
    expect(mintSupply()).to.equal(SUPPLY);
    expect(rawBalance(source)).to.equal(SUPPLY);
  });

  it("cannot mint more, even during market hours", () => {
    setClock(T.openRegular.ts);
    const before = mintSupply();
    const result = send(
      [
        createMintToInstruction(
          mint.publicKey, source, payer.publicKey, 1n, [], TOKEN_2022_PROGRAM_ID
        ),
      ],
      [payer]
    );
    expect(result instanceof FailedTransactionMetadata, "minting should be impossible").to.be.true;
    expect(mintSupply()).to.equal(before);
  });

  it("cannot repoint the transfer hook at another program", () => {
    setClock(T.openRegular.ts);
    const result = send(
      [
        createUpdateTransferHookInstruction(
          mint.publicKey,
          payer.publicKey,
          SystemProgram.programId, // a no-op target
          [],
          TOKEN_2022_PROGRAM_ID
        ),
      ],
      [payer]
    );
    expect(result instanceof FailedTransactionMetadata, "hook should be immutable").to.be.true;
  });

  it("cannot freeze a holder's account", () => {
    setClock(T.openRegular.ts);
    const result = send(
      [
        createSetAuthorityInstruction(
          mint.publicKey, payer.publicKey, AuthorityType.FreezeAccount,
          payer.publicKey, [], TOKEN_2022_PROGRAM_ID
        ),
      ],
      [payer]
    );
    expect(result instanceof FailedTransactionMetadata, "freeze authority should be dead").to.be
      .true;
  });

  it("still blocks transfers outside market hours", () => {
    setClock(T.weekend.ts);
    const before = rawBalance(destination);
    const result = send([transferIx(1_000n)], [payer]);
    expect(result instanceof FailedTransactionMetadata, "weekend transfer should fail").to.be.true;
    expect(rawBalance(destination)).to.equal(before);
  });

  it("allows transfers during market hours", () => {
    setClock(T.openRegular.ts);
    const before = rawBalance(destination);
    const result = send([transferIx(1_000n)], [payer]);
    expect(result instanceof FailedTransactionMetadata, "session transfer should succeed").to.be
      .false;
    expect(rawBalance(destination) - before).to.equal(1_000n);
  });

  it("supply stays constant across all of it", () => {
    expect(mintSupply()).to.equal(SUPPLY);
  });
});

/**
 * A market is data, but not free-form data.
 *
 * The program hashes the submitted schedule and refuses anything that is not
 * one of its compiled-in markets, so nobody -- including us -- can launch a
 * token on this hook with hours of their own choosing. Once the upgrade
 * authority is burned that list is fixed forever, and a new market means a new
 * program with its own address.
 */
describe("only approved markets can be launched", () => {
  const ERR_UNAPPROVED = 6013; // HookError::UnapprovedMarket

  let svm: LiteSVM;
  let payer: Keypair;

  function send(ixs: TransactionInstruction[], signers: Keypair[]) {
    svm.expireBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = payer.publicKey;
    ixs.forEach((i) => tx.add(i));
    tx.sign(payer, ...signers);
    return svm.sendTransaction(tx);
  }

  /** Create a hooked mint, then try to give it `schedule`. */
  function tryLaunch(schedule: Parameters<typeof initializeScheduleIx>[2]) {
    const mint = Keypair.generate();
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const made = send([
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: mintLen,
        lamports: Number(svm.minimumBalanceForRentExemption(BigInt(mintLen))),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(mint.publicKey, PublicKey.default, PROGRAM_ID, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ], [mint]);
    expect(made instanceof FailedTransactionMetadata, "mint creation should succeed").to.be.false;
    return send([initializeScheduleIx(mint.publicKey, payer.publicKey, schedule)], []);
  }

  before(() => {
    svm = new LiteSVM().withBuiltins().withSplPrograms().withSysvars();
    svm.addProgramFromFile(PROGRAM_ID, SO_PATH);
    payer = Keypair.generate();
    svm.airdrop(payer.publicKey, 100_000_000_000n);
    const c = svm.getClock();
    c.unixTimestamp = T.openRegular.ts;
    svm.setClock(c);
  });

  it("accepts the NYSE preset", () => {
    const r = tryLaunch(NYSE);
    expect(
      r instanceof FailedTransactionMetadata,
      `NYSE should be accepted, got ${r instanceof FailedTransactionMetadata ? r.err().toString() : ""}`
    ).to.be.false;
  });

  it("rejects hours a user invented", () => {
    const custom = { ...NYSE, windows: [{ daysMask: 0b1111111, openMinute: 0, closeMinute: 1440 }] };
    const r = tryLaunch(custom);
    expect(r instanceof FailedTransactionMetadata, "24/7 hours must be rejected").to.be.true;
    expect((r as FailedTransactionMetadata).err().toString()).to.contain(String(ERR_UNAPPROVED));
  });

  it("rejects a one-minute tweak to an approved market", () => {
    const nudged = {
      ...NYSE,
      windows: [{ ...NYSE.windows[0], closeMinute: NYSE.windows[0].closeMinute + 1 }],
    };
    const r = tryLaunch(nudged);
    expect(r instanceof FailedTransactionMetadata, "a nudged close must be rejected").to.be.true;
    expect((r as FailedTransactionMetadata).err().toString()).to.contain(String(ERR_UNAPPROVED));
  });

  it("rejects NYSE with a holiday quietly removed", () => {
    const fewer = { ...NYSE, holidays: NYSE.holidays.slice(0, -1) };
    const r = tryLaunch(fewer);
    expect(r instanceof FailedTransactionMetadata, "a trimmed holiday list must be rejected").to.be.true;
    expect((r as FailedTransactionMetadata).err().toString()).to.contain(String(ERR_UNAPPROVED));
  });
});

/**
 * The market registry.
 *
 * A market the program was not compiled with can still be approved, by a key
 * we hold, without a program upgrade and without a new hook address. That is
 * what lets the upgrade authority be burned while the market list still grows.
 *
 * What the registry key CANNOT do: change the program, or reach a token that
 * has already launched. A token copies its schedule into its own account at
 * launch, so approving or revoking a market afterwards is invisible to it.
 */
describe("market registry", () => {
  const ERR_UNAPPROVED = 6013;
  // Matches REGISTRY_BOOTSTRAP in lib.rs.
  const BOOTSTRAP = new PublicKey("FTnprQrxXRGBAJRg8axCbocBNeSvQC3YoCFqEE8khJ3c");

  // A market the program has never heard of: London, EU daylight-saving rule.
  const LSE = {
    id: "lse", label: "LSE", tzOffsetMinutes: 0, dstRule: 2, baseDay: 20454,
    windows: [{ daysMask: 0b0111110, openMinute: 480, closeMinute: 990 }],
    holidays: [], earlyCloses: [], events: [],
  };

  let svm: LiteSVM;
  let payer: Keypair;

  function send(ixs: TransactionInstruction[], signers: Keypair[] = []) {
    svm.expireBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = payer.publicKey;
    ixs.forEach((i) => tx.add(i));
    tx.sign(payer, ...signers);
    return svm.sendTransaction(tx);
  }

  function makeHookedMint(): Keypair {
    const mint = Keypair.generate();
    const mintLen = getMintLen([ExtensionType.TransferHook]);
    const r = send([
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: mintLen,
        lamports: Number(svm.minimumBalanceForRentExemption(BigInt(mintLen))),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(mint.publicKey, PublicKey.default, PROGRAM_ID, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mint.publicKey, DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ], [mint]);
    expect(r instanceof FailedTransactionMetadata, "mint creation").to.be.false;
    return mint;
  }

  before(() => {
    svm = new LiteSVM().withBuiltins().withSplPrograms().withSysvars();
    svm.addProgramFromFile(PROGRAM_ID, SO_PATH);
    // The bootstrap key must be the signer, so run as it.
    payer = Keypair.generate();
    svm.airdrop(payer.publicKey, 100_000_000_000n);
    const c = svm.getClock();
    c.unixTimestamp = T.openRegular.ts;
    svm.setClock(c);
  });

  it("refuses an unregistered market", () => {
    const mint = makeHookedMint();
    const r = send([initializeScheduleIx(mint.publicKey, payer.publicKey, LSE as any)]);
    expect(r instanceof FailedTransactionMetadata, "LSE is not compiled in").to.be.true;
    expect((r as FailedTransactionMetadata).err().toString()).to.contain(String(ERR_UNAPPROVED));
  });

  it("only the bootstrap key can create the registry", () => {
    const r = send([initializeRegistryIx(payer.publicKey, payer.publicKey)]);
    expect(r instanceof FailedTransactionMetadata, "a random key must not bootstrap").to.be.true;
    expect(svm.getAccount(registryAddress()), "registry must not exist").to.be.null;
  });

  /**
   * Place an approved-market account directly.
   *
   * register_market is gated on the registry authority, and REGISTRY_BOOTSTRAP
   * is the launch wallet whose key this suite does not have. Writing the
   * account is how we exercise what `initialize` does with one; the authority
   * gate itself is covered by the bootstrap test above and on devnet before
   * mainnet.
   */
  function placeMarketAccount(atPda: PublicKey, hashInside: Buffer) {
    const disc = createHash("sha256").update("account:Market").digest().subarray(0, 8);
    svm.setAccount(atPda, {
      lamports: 2_000_000,
      data: Buffer.concat([disc, hashInside]),
      owner: PROGRAM_ID,
      executable: false,
      rentEpoch: 0,
    });
  }

  it("accepts a market the registry has approved", () => {
    const hash = scheduleHash(LSE as any);
    placeMarketAccount(marketAddress(hash), hash);
    const mint = makeHookedMint();
    const r = send([initializeScheduleIx(mint.publicKey, payer.publicKey, LSE as any, true)]);
    expect(
      r instanceof FailedTransactionMetadata,
      `registered LSE should be accepted, got ${
        r instanceof FailedTransactionMetadata ? r.err().toString() : ""
      }`
    ).to.be.false;
  });

  it("rejects a market account holding a different schedule's hash", () => {
    const lseHash = scheduleHash(LSE as any);
    // Right PDA for LSE, but the stored hash is NYSE's.
    placeMarketAccount(marketAddress(lseHash), scheduleHash(NYSE));
    const mint = makeHookedMint();
    const r = send([initializeScheduleIx(mint.publicKey, payer.publicKey, LSE as any, true)]);
    expect(r instanceof FailedTransactionMetadata, "hash mismatch must be rejected").to.be.true;
    expect((r as FailedTransactionMetadata).err().toString()).to.contain(String(ERR_UNAPPROVED));
  });

  it("rejects an approved market presented at the wrong address", () => {
    // A genuinely approved market, but handed in for a different schedule --
    // this is what the handler's PDA check exists to stop.
    const other = { ...LSE, windows: [{ daysMask: 0b0111110, openMinute: 60, closeMinute: 120 }] };
    const otherHash = scheduleHash(other as any);
    placeMarketAccount(marketAddress(otherHash), otherHash);
    const mint = makeHookedMint();
    const ix = initializeScheduleIx(mint.publicKey, payer.publicKey, LSE as any, true);
    ix.keys[4] = { pubkey: marketAddress(otherHash), isSigner: false, isWritable: false };
    const r = send([ix]);
    expect(r instanceof FailedTransactionMetadata, "wrong-address market must be rejected").to.be.true;
    expect((r as FailedTransactionMetadata).err().toString()).to.contain(String(ERR_UNAPPROVED));
  });
});
