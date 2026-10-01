/**
 * Probe every token on a transfer-hook program for whether transfers are
 * actually blocked right now.
 *
 * For each mint it finds a funded holder, builds a real TransferChecked with
 * the hook's resolved extra accounts, and simulates it against LIVE mainnet
 * (sigVerify disabled: nothing signed, nothing sent, nothing spent). The
 * simulation uses the cluster's real Clock, so the result describes this
 * moment only -- run it while the market is open and again while it is closed.
 *
 *   npx ts-node scripts/probe-hooked-tokens.ts --hook <PROGRAM> [--mints a,b,c]
 */
import { Connection, PublicKey, Transaction, clusterApiUrl } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, getMint, getTransferHook, getExtraAccountMetaAddress,
  getExtraAccountMetas, resolveExtraAccountMeta, createTransferCheckedInstruction,
  getExtensionData, ExtensionType,
} from "@solana/spl-token";
import { unpack as unpackMetadata } from "@solana/spl-token-metadata";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function nyseStateNow(): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  const m = Number(p.hour) * 60 + Number(p.minute);
  if (p.weekday === "Sat" || p.weekday === "Sun") return "WEEKEND (closed)";
  if (m < 9 * 60 + 30) return "PRE-MARKET (closed)";
  if (m < 16 * 60) return "OPEN";
  return "AFTER HOURS (closed)";
}

/** Token accounts for a mint, largest first, via a memcmp scan. */
async function holders(c: Connection, mint: PublicKey) {
  const res = await c.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });
  return res
    .map((r) => ({
      pubkey: r.pubkey,
      owner: new PublicKey(r.account.data.subarray(32, 64)),
      amount: r.account.data.readBigUInt64LE(64),
    }))
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
}

async function probe(c: Connection, mintAddress: PublicKey) {
  const mint = await getMint(c, mintAddress, "confirmed", TOKEN_2022_PROGRAM_ID);
  const hook = getTransferHook(mint);
  let name = "?";
  try {
    const raw = getExtensionData(ExtensionType.TokenMetadata, mint.tlvData);
    if (raw) name = unpackMetadata(raw).symbol || unpackMetadata(raw).name;
  } catch { /* no metadata */ }

  if (!hook || hook.programId.equals(PublicKey.default)) {
    return { name, verdict: "NO HOOK", cu: "-", note: "hook revoked or absent" };
  }

  await sleep(1200);
  const hs = await holders(c, mintAddress);
  const funded = hs.find((h) => h.amount > 0n);
  if (!funded) return { name, verdict: "SKIP", cu: "-", note: "no funded holder" };
  const dst = hs.find((h) => !h.pubkey.equals(funded.pubkey));
  if (!dst) return { name, verdict: "SKIP", cu: "-", note: "no second token account" };

  const ix = createTransferCheckedInstruction(
    funded.pubkey, mintAddress, dst.pubkey, funded.owner, 1n, mint.decimals, [], TOKEN_2022_PROGRAM_ID
  );

  const validation = getExtraAccountMetaAddress(mintAddress, hook.programId);
  await sleep(1200);
  const vInfo = await c.getAccountInfo(validation, "confirmed");
  if (vInfo) {
    const metas = getExtraAccountMetas(vInfo);
    const execKeys: any[] = [
      { pubkey: funded.pubkey, isSigner: false, isWritable: true },
      { pubkey: mintAddress, isSigner: false, isWritable: false },
      { pubkey: dst.pubkey, isSigner: false, isWritable: true },
      { pubkey: funded.owner, isSigner: false, isWritable: false },
      { pubkey: validation, isSigner: false, isWritable: false },
    ];
    for (const m of metas) {
      const r = await resolveExtraAccountMeta(c, m, execKeys, Buffer.alloc(0), hook.programId);
      execKeys.push(r);
      ix.keys.push({ pubkey: r.pubkey, isSigner: false, isWritable: false });
    }
    ix.keys.push({ pubkey: hook.programId, isSigner: false, isWritable: false });
    ix.keys.push({ pubkey: validation, isSigner: false, isWritable: false });
  }

  const tx = new Transaction().add(ix);
  tx.feePayer = funded.owner;
  await sleep(800);
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;

  const encoded = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  await sleep(800);
  const res: any = await (c as any)._rpcRequest("simulateTransaction", [
    encoded,
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
  ]);
  if (res.error) return { name, verdict: "RPC ERR", cu: "-", note: JSON.stringify(res.error).slice(0, 50) };
  const v = res.result.value;
  const logs: string[] = v.logs ?? [];
  const hookLine = logs.find((l) => l.includes(hook.programId.toBase58()) && l.includes("consumed"));
  const hookCu = hookLine ? /consumed (\d+)/.exec(hookLine)?.[1] ?? "?" : "not invoked";
  return {
    name,
    verdict: v.err ? "BLOCKED" : "TRADEABLE",
    cu: hookCu,
    note: v.err ? JSON.stringify(v.err).slice(0, 44) : "",
  };
}

(async () => {
  const c = new Connection(arg("rpc", clusterApiUrl("mainnet-beta")), "confirmed");
  const mints = arg("mints").split(",").map((s) => new PublicKey(s.trim()));

  console.log(`eastern time     ${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "medium" }).format(new Date())}`);
  console.log(`real NYSE state  ${nyseStateNow()}`);
  console.log(`tokens           ${mints.length}\n`);
  console.log("symbol    mint                                           verdict     hook CU      error");
  console.log("-".repeat(104));

  let tradeable = 0, blocked = 0;
  for (const m of mints) {
    let r;
    try { r = await probe(c, m); }
    catch (e: any) { r = { name: "?", verdict: "ERROR", cu: "-", note: (e.message ?? String(e)).slice(0, 44) }; }
    if (r.verdict === "TRADEABLE") tradeable++;
    if (r.verdict === "BLOCKED") blocked++;
    console.log(`${r.name.padEnd(9)} ${m.toBase58().padEnd(46)} ${r.verdict.padEnd(11)} ${String(r.cu).padEnd(12)} ${r.note}`);
    await sleep(1500);
  }
  console.log("-".repeat(104));
  console.log(`tradeable right now: ${tradeable}    blocked right now: ${blocked}`);
  if (nyseStateNow() !== "OPEN" && tradeable > 0) {
    console.log(`\n>>> ${tradeable} token(s) are transferable while the NYSE is CLOSED.`);
  }
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
