/**
 * Verify the hook on a REAL Solana runtime, not LiteSVM.
 *
 * Runs against a local solana-test-validator whose clock follows real time, so
 * it checks the hook's verdict against the actual NYSE state right now. This
 * exercises the real BPF loader, real CU metering and the real Clock sysvar.
 *
 *   solana-test-validator --reset \
 *     --bpf-program CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k \
 *       target/deploy/nyse_token_hook.so
 *   npx ts-node scripts/verify-on-validator.ts
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, getMintLen,
  createInitializeMintInstruction, createInitializeTransferHookInstruction,
  createAssociatedTokenAccountInstruction, createMintToInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";

const HOOK = new PublicKey("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";

/** Independent expectation, computed here rather than by the program. */
function expectedState(now: Date): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit",
    minute: "2-digit", hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  const weekday = parts.weekday as string;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (weekday === "Sat" || weekday === "Sun") return "WEEKEND";
  if (minutes < 9 * 60 + 30) return "PRE_MARKET";
  if (minutes < 16 * 60) return "OPEN";
  return "AFTER_HOURS";
}

(async () => {
  const connection = new Connection(RPC, "confirmed");
  const payer = Keypair.generate();

  const sig = await connection.requestAirdrop(payer.publicKey, 5_000_000_000);
  await connection.confirmTransaction(sig, "confirmed");

  const now = new Date();
  const expected = expectedState(now);
  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", dateStyle: "medium", timeStyle: "medium",
  }).format(now);

  // Compare the cluster's clock against real time, since the hook trusts it.
  const clockInfo = await connection.getAccountInfo(
    new PublicKey("SysvarC1ock11111111111111111111111111111111")
  );
  const onChain = clockInfo ? Number(clockInfo.data.readBigInt64LE(32)) : NaN;
  const drift = onChain - Math.floor(now.getTime() / 1000);

  console.log(`rpc              ${RPC}`);
  console.log(`eastern time     ${et}`);
  console.log(`expected state   ${expected}`);
  console.log(`cluster clock    ${onChain} (drift ${drift >= 0 ? "+" : ""}${drift}s vs real time)`);

  const mint = Keypair.generate();
  const [extraMetas] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()], HOOK
  );
  const mintLen = getMintLen([ExtensionType.TransferHook]);

  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: mintLen,
      lamports: await connection.getMinimumBalanceForRentExemption(mintLen),
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferHookInstruction(mint.publicKey, payer.publicKey, HOOK, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, 9, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ), [payer, mint]);

  await sendAndConfirmTransaction(connection, new Transaction().add({
    programId: HOOK,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: extraMetas, isSigner: false, isWritable: true },
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: createHash("sha256").update("global:initialize_extra_account_meta_list").digest().subarray(0, 8),
  }), [payer]);

  const src = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const dstOwner = Keypair.generate();
  const dst = getAssociatedTokenAddressSync(mint.publicKey, dstOwner.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    createAssociatedTokenAccountInstruction(payer.publicKey, src, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(payer.publicKey, dst, dstOwner.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, src, payer.publicKey, 10n ** 15n, [], TOKEN_2022_PROGRAM_ID),
  ), [payer]);

  const ix = createTransferCheckedInstruction(src, mint.publicKey, dst, payer.publicKey, 1_000n, 9, [], TOKEN_2022_PROGRAM_ID);
  ix.keys.push({ pubkey: HOOK, isSigner: false, isWritable: false });
  ix.keys.push({ pubkey: extraMetas, isSigner: false, isWritable: false });

  let transferred = false;
  let observed = "";
  let cu: number | null = null;
  try {
    const tsig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
    transferred = true;
    const tx = await connection.getTransaction(tsig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    cu = tx?.meta?.computeUnitsConsumed ?? null;
    const logs = tx?.meta?.logMessages ?? [];
    if (!logs.some((l) => l.includes(HOOK.toBase58()))) {
      throw new Error("transfer succeeded but the hook never ran");
    }
    observed = "OPEN";
  } catch (e: any) {
    const logs: string[] = e?.logs ?? [];
    const line = logs.find((l) => /custom program error/.test(l)) ?? e.message;
    const code = /0x(177[0-3])/.exec(logs.join(" "));
    observed = code
      ? { "1770": "WEEKEND", "1771": "HOLIDAY", "1772": "PRE_MARKET", "1773": "AFTER_HOURS" }[code[1]]!
      : `unexpected: ${line}`;
  }

  console.log(`\ntransfer         ${transferred ? "SUCCEEDED" : "BLOCKED"}`);
  if (cu !== null) console.log(`compute units    ${cu}`);
  console.log(`hook verdict     ${observed}`);

  // A failure path that does not depend on the clock, so it can be checked on
  // real hardware at any time: calling Execute directly must be rejected.
  const executeData = Buffer.concat([
    createHash("sha256").update("spl-transfer-hook-interface:execute").digest().subarray(0, 8),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(1_000n); return b; })(),
  ]);
  let directRejected = false;
  try {
    await sendAndConfirmTransaction(connection, new Transaction().add({
      programId: HOOK,
      keys: [
        { pubkey: src, isSigner: false, isWritable: false },
        { pubkey: mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: dst, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: false, isWritable: false },
        { pubkey: extraMetas, isSigner: false, isWritable: false },
      ],
      data: executeData,
    }), [payer]);
  } catch (e: any) {
    const logs: string[] = e?.logs ?? [];
    // 6004 NotTransferring == 0x1774
    directRejected = /0x1774/.test(logs.join(" "));
    if (!directRejected) console.log(`  direct call failed, but not with NotTransferring: ${logs.slice(-2).join(" | ")}`);
  }
  console.log(`direct Execute   ${directRejected ? "REJECTED (NotTransferring)" : "NOT REJECTED"}`);

  const agree = observed === expected;
  const pass = agree && directRejected;
  console.log(`\n${pass ? "PASS" : "FAIL"}: hook says ${observed}, real NYSE is ${expected}; direct call ${directRejected ? "rejected" : "NOT rejected"}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
