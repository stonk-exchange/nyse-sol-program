/**
 * Does a hooked mint treat a wallet-to-wallet send differently from a trade?
 *
 * hookedpad documents its hook as "wallet-to-wallet sends always work", which
 * would mean the hook gates pool interactions but not plain sends. This checks
 * that against live mainnet by simulating both shapes, with sigVerify disabled
 * so nothing is signed, sent or paid for.
 *
 * Holders are classified by whether the token account's OWNER is on the ed25519
 * curve: on-curve is a real wallet, off-curve is a PDA, which in practice means
 * a pool vault or similar program-owned account.
 *
 *   npx ts-node scripts/probe-transfer-kinds.ts --mint <MINT>
 */
import { Connection, PublicKey, Transaction, clusterApiUrl } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getMint, getTransferHook, getExtraAccountMetaAddress,
  getExtraAccountMetas, resolveExtraAccountMeta, createTransferCheckedInstruction,
} from "@solana/spl-token";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function arg(n: string, d?: string): string {
  const i = process.argv.indexOf(`--${n}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (d !== undefined) return d;
  throw new Error(`missing --${n}`);
}
function nyseNow(): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const m = Number(p.hour) * 60 + Number(p.minute);
  if (p.weekday === "Sat" || p.weekday === "Sun") return "WEEKEND (closed)";
  if (m < 570) return "PRE-MARKET (closed)";
  return m < 960 ? "OPEN" : "AFTER HOURS (closed)";
}

(async () => {
  const mintAddr = new PublicKey(arg("mint"));
  const c = new Connection(arg("rpc", clusterApiUrl("mainnet-beta")), "confirmed");
  const mint = await getMint(c, mintAddr, "confirmed", TOKEN_2022_PROGRAM_ID);
  const hook = getTransferHook(mint)!;

  console.log(`eastern time  ${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "medium" }).format(new Date())}`);
  console.log(`NYSE state    ${nyseNow()}`);
  console.log(`mint          ${mintAddr.toBase58()}`);
  console.log(`hook          ${hook.programId.toBase58()}\n`);

  await sleep(1200);
  const raw = await c.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: mintAddr.toBase58() } }],
  });
  const accts = raw.map((r) => {
    const owner = new PublicKey(r.account.data.subarray(32, 64));
    return { pubkey: r.pubkey, owner, amount: r.account.data.readBigUInt64LE(64), isWallet: PublicKey.isOnCurve(owner.toBytes()) };
  }).sort((a, b) => (b.amount > a.amount ? 1 : -1));

  const walletFunded = accts.find((a) => a.isWallet && a.amount > 0n);
  const walletAny = accts.find((a) => a.isWallet && (!walletFunded || !a.pubkey.equals(walletFunded.pubkey)));
  const pdaFunded = accts.find((a) => !a.isWallet && a.amount > 0n);
  console.log(`holders: ${accts.length}  (wallet-owned: ${accts.filter(a=>a.isWallet).length}, PDA-owned: ${accts.filter(a=>!a.isWallet).length})`);

  async function sim(from: any, to: any, label: string) {
    if (!from || !to) { console.log(`  ${label.padEnd(34)} SKIP (no suitable accounts)`); return; }
    const ix = createTransferCheckedInstruction(from.pubkey, mintAddr, to.pubkey, from.owner, 1n, mint.decimals, [], TOKEN_2022_PROGRAM_ID);
    const val = getExtraAccountMetaAddress(mintAddr, hook.programId);
    await sleep(900);
    const vi = await c.getAccountInfo(val, "confirmed");
    if (vi) {
      const metas = getExtraAccountMetas(vi);
      const keys: any[] = [
        { pubkey: from.pubkey, isSigner: false, isWritable: true },
        { pubkey: mintAddr, isSigner: false, isWritable: false },
        { pubkey: to.pubkey, isSigner: false, isWritable: true },
        { pubkey: from.owner, isSigner: false, isWritable: false },
        { pubkey: val, isSigner: false, isWritable: false },
      ];
      for (const m of metas) {
        const r = await resolveExtraAccountMeta(c, m, keys, Buffer.alloc(0), hook.programId);
        keys.push(r); ix.keys.push({ pubkey: r.pubkey, isSigner: false, isWritable: false });
      }
      ix.keys.push({ pubkey: hook.programId, isSigner: false, isWritable: false });
      ix.keys.push({ pubkey: val, isSigner: false, isWritable: false });
    }
    const tx = new Transaction().add(ix);
    tx.feePayer = from.owner;
    await sleep(700);
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    const enc = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    await sleep(700);
    const res: any = await (c as any)._rpcRequest("simulateTransaction", [enc,
      { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }]);
    const v = res.result?.value;
    if (!v) { console.log(`  ${label.padEnd(34)} RPC error`); return; }
    const logs: string[] = v.logs ?? [];
    const cu = (logs.find((l) => l.includes(hook.programId.toBase58()) && l.includes("consumed")) || "").match(/consumed (\d+)/)?.[1] ?? "n/a";
    console.log(`  ${label.padEnd(34)} ${(v.err ? "BLOCKED" : "ALLOWED").padEnd(9)} hook cu=${String(cu).padEnd(7)} ${v.err ? JSON.stringify(v.err) : ""}`);
  }

  console.log("");
  await sim(walletFunded, walletAny, "wallet -> wallet (plain send)");
  await sleep(1200);
  await sim(pdaFunded, walletFunded, "PDA vault -> wallet (a trade)");
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
