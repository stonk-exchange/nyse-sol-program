/**
 * Simulate a real transfer of a hooked mint against LIVE mainnet state.
 *
 * Uses simulateTransaction with signature verification disabled, so nothing is
 * signed, sent, or paid for -- but the simulation runs on the real cluster
 * against real accounts and the real Clock. That makes it the strongest
 * available evidence of whether a hook blocks at the current moment.
 *
 * Because it uses the live clock, the result only tells you about right now.
 * Run it while the market is open and again while it is closed.
 *
 *   npx ts-node scripts/probe-mainnet-hook.ts --mint <MINT>
 */
import {
  Connection, PublicKey, Transaction, TransactionInstruction, Keypair, clusterApiUrl,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getMint, getTransferHook, getExtraAccountMetaAddress,
  getExtraAccountMetas, resolveExtraAccountMeta, createTransferCheckedInstruction,
} from "@solana/spl-token";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function nyseStateNow(): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "2-digit",
      minute: "2-digit", hour12: false,
    }).formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  const m = Number(p.hour) * 60 + Number(p.minute);
  if (p.weekday === "Sat" || p.weekday === "Sun") return "WEEKEND (closed)";
  if (m < 9 * 60 + 30) return "PRE-MARKET (closed)";
  if (m < 16 * 60) return "OPEN";
  return "AFTER HOURS (closed)";
}

(async () => {
  const mintAddress = new PublicKey(arg("mint"));
  const connection = new Connection(arg("rpc", clusterApiUrl("mainnet-beta")), "confirmed");

  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", dateStyle: "medium", timeStyle: "medium",
  }).format(new Date());
  console.log(`eastern time     ${et}`);
  console.log(`real NYSE state  ${nyseStateNow()}`);

  const mint = await getMint(connection, mintAddress, "confirmed", TOKEN_2022_PROGRAM_ID);
  const hook = getTransferHook(mint);
  if (!hook || hook.programId.equals(PublicKey.default)) {
    console.log("\nThis mint has no active transfer hook.");
    return;
  }
  console.log(`hook program     ${hook.programId.toBase58()}`);

  // Real token accounts to move between. getTokenLargestAccounts is throttled
  // hard on public RPC, so they are passed in explicitly.
  const src = new PublicKey(arg("from"));
  const dst = new PublicKey(arg("to"));
  const srcRaw = await connection.getAccountInfo(src, "confirmed");
  if (!srcRaw) throw new Error("source token account not found");
  const srcOwner = new PublicKey(srcRaw.data.subarray(32, 64));
  const srcBalance = srcRaw.data.readBigUInt64LE(64);

  console.log(`source account   ${src.toBase58()} (${srcBalance} base units)`);
  console.log(`source authority ${srcOwner.toBase58()}`);
  console.log(`dest account     ${dst.toBase58()}`);
  if (srcBalance === 0n) throw new Error("source has no balance to transfer");

  const amount = 1n;
  const ix = createTransferCheckedInstruction(
    src, mintAddress, dst, srcOwner, amount, mint.decimals, [], TOKEN_2022_PROGRAM_ID
  );

  // Resolve the hook's extra accounts exactly as a wallet or AMM would.
  const validation = getExtraAccountMetaAddress(mintAddress, hook.programId);
  const vInfo = await connection.getAccountInfo(validation, "confirmed");
  if (vInfo) {
    const metas = getExtraAccountMetas(vInfo);
    const execKeys: any[] = [
      { pubkey: src, isSigner: false, isWritable: true },
      { pubkey: mintAddress, isSigner: false, isWritable: false },
      { pubkey: dst, isSigner: false, isWritable: true },
      { pubkey: srcOwner, isSigner: false, isWritable: false },
      { pubkey: validation, isSigner: false, isWritable: false },
    ];
    for (const m of metas) {
      const resolved = await resolveExtraAccountMeta(
        connection, m, execKeys, Buffer.alloc(0), hook.programId
      );
      execKeys.push(resolved);
      ix.keys.push({ pubkey: resolved.pubkey, isSigner: false, isWritable: false });
    }
    ix.keys.push({ pubkey: hook.programId, isSigner: false, isWritable: false });
    ix.keys.push({ pubkey: validation, isSigner: false, isWritable: false });
    console.log(`extra accounts   ${metas.length} resolved from the validation state`);
  }

  const tx = new Transaction().add(ix);
  tx.feePayer = srcOwner;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  // Raw simulateTransaction with sigVerify disabled: nothing is signed, nothing
  // is sent, nothing is paid. The cluster still executes it against real
  // account state and the real Clock.
  const encoded = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  const res: any = await (connection as any)._rpcRequest("simulateTransaction", [
    encoded,
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
  ]);
  if (res.error) throw new Error(`simulate rpc error: ${JSON.stringify(res.error)}`);
  const value = res.result.value;
  const logs: string[] = value.logs ?? [];
  const hookRan = logs.some((l) => l.includes(hook.programId.toBase58()));

  console.log(`\nsimulation       ${value.err ? "FAILED (transfer blocked)" : "SUCCEEDED (transfer allowed)"}`);
  console.log(`hook invoked     ${hookRan ? "yes" : "NO -- it was never called"}`);
  if (value.err) console.log(`error            ${JSON.stringify(value.err)}`);
  console.log(`compute units    ${value.unitsConsumed ?? "?"}`);
  console.log("\n--- logs ---");
  logs.forEach((l) => console.log("  " + l));
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
