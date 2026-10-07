/**
 * Create the address lookup table that lets a token launch in ONE transaction.
 *
 * A launch is two instructions: DBC creates the mint and pool, and the hook
 * writes the schedule plus its validation state. As a legacy transaction the
 * pair is 1286 bytes, over the 1232 limit, so they have to be sent separately.
 * That split is not free -- if the second lands and the first does not the token
 * is unusable, and in between the two anyone can call initialize and choose the
 * calendar.
 *
 * The overflow is mostly account keys, not data: 17 accounts at 32 bytes each.
 * Eleven of them are the same for every launch (programs, the config, the quote
 * mint, DBC's authorities, the fee claimer). Put those in a lookup table and a
 * v0 transaction references them by one-byte index instead, which brings the
 * pair to 1105 bytes.
 *
 * The other six are derived from the new mint and change every launch, so they
 * cannot be pre-stored.
 *
 *   npx tsx scripts/make-lut.ts --config <CONFIG> --cluster mainnet-beta
 *   npx tsx scripts/make-lut.ts --config <CONFIG> --cluster mainnet-beta --execute
 *
 * A table is tied to the config it was built for, because the config and its
 * quote mint are among the fixed accounts. One per config.
 */
import {
  Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction,
  AddressLookupTableProgram, ComputeBudgetProgram, sendAndConfirmTransaction,
  Transaction, clusterApiUrl,
} from "@solana/web3.js";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { initializeScheduleIx } from "./markets/hook";
import { market, MARKETS } from "./markets/presets";
import * as fs from "fs";
import * as os from "os";

const HOOK_PROGRAM_ID = new PublicKey("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");

function arg(n: string, d?: string): string {
  const i = process.argv.indexOf(`--${n}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (d !== undefined) return d;
  throw new Error(`missing --${n}`);
}

/**
 * The accounts a launch touches that do NOT depend on the new mint.
 *
 * Found by building the launch twice with different mints and keeping the
 * intersection, rather than by listing them by hand -- the SDK decides which
 * accounts its instruction needs, and that list changes between versions.
 */
export async function fixedLaunchAccounts(
  connection: Connection,
  config: PublicKey,
  creator: PublicKey,
  marketId: string
): Promise<PublicKey[]> {
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const chosen = market(marketId);

  const keysFor = async (mint: Keypair) => {
    const poolTx = await client.creator.createPoolWithTransferHook({
      baseMint: mint.publicKey, config, name: "x", symbol: "x", uri: "x",
      payer: creator, poolCreator: creator, transferHookProgram: HOOK_PROGRAM_ID,
    } as any);
    const ixs = [...poolTx.instructions, initializeScheduleIx(mint.publicKey, creator, chosen)];
    const set = new Set<string>();
    for (const ix of ixs) {
      set.add(ix.programId.toBase58());
      ix.keys.forEach((k) => set.add(k.pubkey.toBase58()));
    }
    return set;
  };

  const a = await keysFor(Keypair.generate());
  const b = await keysFor(Keypair.generate());
  // The fee payer signs, and a signer must be a static key in a v0 message, so
  // putting it in the table would save nothing.
  return [...a]
    .filter((k) => b.has(k) && k !== creator.toBase58())
    .map((k) => new PublicKey(k));
}

async function main() {
  const cluster = arg("cluster", "devnet");
  const endpoint = arg("rpc", cluster.startsWith("http") ? cluster : clusterApiUrl(cluster as any));
  const config = new PublicKey(arg("config"));
  const marketId = arg("market", "nyse");
  const execute = process.argv.includes("--execute");

  const walletPath = (process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`).replace(/^~/, os.homedir());
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  const creator = new PublicKey(arg("creator", payer.publicKey.toBase58()));

  const connection = new Connection(endpoint, "confirmed");
  const addresses = await fixedLaunchAccounts(connection, config, creator, marketId);

  console.log("create launch lookup table");
  console.log(`  endpoint   ${endpoint}`);
  console.log(`  config     ${config.toBase58()}`);
  console.log(`  market     ${market(marketId).label}`);
  console.log(`  payer      ${payer.publicKey.toBase58()}`);
  console.log(`  creator    ${creator.toBase58()}  (the launches this table is for)`);
  console.log(`  addresses  ${addresses.length}`);
  for (const a of addresses) console.log(`    ${a.toBase58()}`);

  if (!execute) { console.log("\nDry run. Add --execute to send."); return; }

  const slot = await connection.getSlot("finalized");
  const [createIx, lut] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
  });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey, lookupTable: lut, addresses,
  });
  const sig = await sendAndConfirmTransaction(
    connection, new Transaction().add(createIx, extendIx), [payer], { commitment: "confirmed" });
  console.log("\nlookup table created:", sig);
  console.log("lookup table:", lut.toBase58());

  // A table is only usable a slot after the one it was created against, so the
  // launcher would otherwise fail on a table made moments earlier.
  console.log("\nwaiting for the table to become active...");
  for (let i = 0; i < 30; i++) {
    const got = await connection.getAddressLookupTable(lut);
    if (got.value && got.value.state.addresses.length === addresses.length) {
      console.log(`active, holding ${got.value.state.addresses.length} addresses`);
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`\nlaunch with:  --lut ${lut.toBase58()}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
