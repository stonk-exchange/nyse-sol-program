/**
 * Launch NYSE-hours tokens on a Meteora Dynamic Bonding Curve, with you as the
 * partner collecting the trading fee.
 *
 * Two steps:
 *
 *   config   Create your partner config once. You are the feeClaimer, so every
 *            token launched against it pays you. Reusable forever.
 *   token    Launch a token against that config. Repeat per token.
 *
 * The curve parameters mirror the live HOURS/9-to-5/Jobcoin config
 * (DPPtCcyKPegQTYxzi6HcWK2ezKEByz5PsNpTrRVzSwz7) exactly, except that the fee
 * claimer and leftover receiver are yours.
 *
 * NOTE ON PERMANENCE: DBC holds the mint's transfer-hook authority so it can
 * revoke the hook when the curve completes. The NYSE restriction therefore
 * applies for the bonding-curve phase and ends at graduation. That is inherent
 * to DBC and is the same deal the existing hooked tokens have.
 *
 *   ANCHOR_WALLET=./hot.json npx ts-node scripts/launch-dbc.ts config \
 *     --cluster mainnet-beta --fee-claimer <YOUR_LEDGER_ADDRESS>
 *
 *   ANCHOR_WALLET=./hot.json npx ts-node scripts/launch-dbc.ts token \
 *     --cluster mainnet-beta --config <CONFIG> \
 *     --name "STONKS" --symbol STONKS --uri https://example.com/meta.json
 */
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, clusterApiUrl, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { NATIVE_MINT } from "@solana/spl-token";
import {
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
  DEFAULT_MIGRATED_POOL_MARKET_CAP_FEE_SCHEDULER_PARAMS,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

/**
 * "No vesting". Not DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS: that object carries
 * `totalDuration` while the SDK's validator tests `frequency`, so the default
 * never satisfies its own is-zero check and the config is rejected.
 */
const NO_LIQUIDITY_VESTING = {
  vestingPercentage: 0,
  bpsPerPeriod: 0,
  numberOfPeriods: 0,
  cliffDurationFromMigrationTime: 0,
  frequency: 0,
} as any;
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";

const HOOK_PROGRAM_ID = new PublicKey("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");

/**
 * Curve parameters.
 *
 * The sqrtStartPrice and curve points are taken verbatim from a live
 * 100,000 SOL config on mainnet, because they have to be mathematically
 * consistent with the migration threshold -- DBC rejects a config where they
 * are not. Only the fee and the recipients are ours.
 *
 * The threshold is the whole point. DBC revokes a mint's transfer hook when the
 * curve completes, which would end the trading-hours restriction permanently.
 * That is not configurable. Setting the threshold at 100,000 SOL puts
 * completion out of economic reach, so the hook is never revoked and the hours
 * hold for the life of the token. It is an economic guarantee, not a structural
 * one: enough buying would still graduate the pool and strip the hook.
 */
const CURVE = {
  // 1% trading fee: 10_000_000 / FEE_DENOMINATOR (1e9).
  // Meteora keeps 20% of it as protocol fee, so the claimer nets ~0.8%.
  cliffFeeNumerator: new BN(10_000_000),
  sqrtStartPrice: new BN("101036978416954620"),
  migrationQuoteThreshold: new BN("100000000000000"), // 100,000 SOL
  points: [
    {
      sqrtPrice: new BN("449154274387104154620"),
      liquidity: new BN("75777733812715966441353696383589"),
    },
  ],
  tokenSupply: new BN("1000000000000000"), // 1e15 base units = 1B at 6 decimals
  tokenDecimal: 6,
  migrationFeePercentage: 0,
  migratedPoolFeeBps: 0,
};

/**
 * DBC creates the mint and points it at our hook, but it has no way to know
 * our program also needs its validation state initialised. Without this
 * account Token-2022 cannot resolve the hook's extra accounts and every swap
 * fails with MissingRemainingAccountForTransferHook (DBC error 6071).
 */
function initHookStateIx(mint: PublicKey, payer: PublicKey): TransactionInstruction {
  const [extraMetas] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    HOOK_PROGRAM_ID
  );
  return new TransactionInstruction({
    programId: HOOK_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: extraMetas, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: createHash("sha256").update("global:initialize_extra_account_meta_list").digest().subarray(0, 8),
  });
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function loadWallet(): Keypair {
  const path = (process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`).replace(/^~/, os.homedir());
  if (!fs.existsSync(path)) throw new Error(`wallet not found at ${path}; set ANCHOR_WALLET`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

function configParameters(feeClaimer: PublicKey) {
  return {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: CURVE.cliffFeeNumerator,
        firstFactor: 0,
        secondFactor: new BN(0),
        thirdFactor: new BN(0),
        baseFeeMode: 0,
      },
      dynamicFee: null,
    },
    collectFeeMode: 0,
    migrationOption: 1, // DAMM v2
    activationType: 1, // timestamp
    tokenType: 1, // Token-2022, required for a transfer hook
    tokenDecimal: CURVE.tokenDecimal,
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 50,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 50,
    migrationQuoteThreshold: CURVE.migrationQuoteThreshold,
    sqrtStartPrice: CURVE.sqrtStartPrice,
    lockedVesting: {
      amountPerPeriod: new BN(0),
      cliffDurationFromMigrationTime: new BN(0),
      frequency: new BN(0),
      numberOfPeriod: new BN(0),
      cliffUnlockAmount: new BN(0),
    },
    migrationFeeOption: 2, // FixedBps100
    tokenSupply: {
      preMigrationTokenSupply: CURVE.tokenSupply,
      postMigrationTokenSupply: CURVE.tokenSupply,
    },
    // 0% to the token creator: the whole trading fee goes to the partner.
    creatorTradingFeePercentage: 0,
    tokenUpdateAuthority: 1, // Immutable: name, symbol and uri can never change
    migrationFee: {
      feePercentage: CURVE.migrationFeePercentage,
      creatorFeePercentage: 0,
    },
    migratedPoolFee: {
      collectFeeMode: 0,
      dynamicFee: 0,
      poolFeeBps: CURVE.migratedPoolFeeBps,
    },
    poolCreationFee: new BN(0),
    // These are required rather than nullable; the all-zero defaults mean
    // "no vesting" and "no market-cap fee scheduler", matching the live config.
    partnerLiquidityVestingInfo: NO_LIQUIDITY_VESTING,
    creatorLiquidityVestingInfo: NO_LIQUIDITY_VESTING,
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams:
      DEFAULT_MIGRATED_POOL_MARKET_CAP_FEE_SCHEDULER_PARAMS,
    curve: CURVE.points,
  } as any;
}

async function main() {
  const cmd = process.argv[2];
  if (cmd !== "config" && cmd !== "token") {
    throw new Error("usage: launch-dbc.ts <config|token> [...]");
  }
  const cluster = arg("cluster", "devnet") as "devnet" | "mainnet-beta";
  const execute = process.argv.includes("--execute");
  const wallet = loadWallet();
  // --rpc overrides the cluster endpoint, so the whole flow can be rehearsed
  // against a local validator with the DBC program cloned in.
  const endpoint = arg("rpc", clusterApiUrl(cluster));
  const connection = new Connection(endpoint, "confirmed");
  const client = DynamicBondingCurveClient.create(connection, "confirmed");

  if (cmd === "config") {
    const feeClaimer = new PublicKey(arg("fee-claimer", wallet.publicKey.toBase58()));
    const config = Keypair.generate();

    console.log("Create DBC partner config");
    console.log(`  endpoint       ${endpoint}`);
    console.log(`  payer          ${wallet.publicKey.toBase58()}`);
    console.log(`  config         ${config.publicKey.toBase58()}`);
    console.log(`  fee claimer    ${feeClaimer.toBase58()}  <-- receives the trading fee`);
    console.log(`  quote mint     SOL`);
    console.log(`  transfer hook  ${HOOK_PROGRAM_ID.toBase58()}`);
    console.log(`  trading fee    1% of every buy and sell`);
    console.log(`  creator share  0% (all of it goes to the fee claimer)`);
    console.log(`  graduates at   ${(Number(CURVE.migrationQuoteThreshold) / 1e9).toLocaleString()} SOL  <-- deliberately out of reach`);
    console.log(`                 DBC revokes the hook when a curve completes, so a`);
    console.log(`                 reachable threshold would end the trading hours.`);
    console.log(`  supply         1,000,000,000 at ${CURVE.tokenDecimal} decimals`);

    if (!execute) { console.log("\nDry run. Add --execute to send."); return; }

    const hook = await connection.getAccountInfo(HOOK_PROGRAM_ID);
    if (!hook?.executable) throw new Error(`hook program is not deployed on ${cluster}`);

    const tx = await client.partner.createConfigWithTransferHook({
      ...configParameters(feeClaimer),
      config: config.publicKey,
      feeClaimer,
      leftoverReceiver: feeClaimer,
      payer: wallet.publicKey,
      quoteMint: NATIVE_MINT,
      transferHookProgram: HOOK_PROGRAM_ID,
    });
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet, config]);
    console.log("\nconfig created:", sig);
    console.log("config address:", config.publicKey.toBase58());
    fs.writeFileSync(`dbc-config-${cluster}.json`, JSON.stringify({
      cluster, config: config.publicKey.toBase58(), feeClaimer: feeClaimer.toBase58(),
      transferHookProgram: HOOK_PROGRAM_ID.toBase58(), tradingFeeBps: 100,
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n");
    console.log(`wrote dbc-config-${cluster}.json -- reuse this config for every future token`);
    return;
  }

  // cmd === "token"
  const config = new PublicKey(arg("config"));
  const name = arg("name");
  const symbol = arg("symbol");
  const uri = arg("uri");
  const baseMint = Keypair.generate();
  const pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, config);

  console.log("Launch token on your DBC config");
  console.log(`  endpoint       ${endpoint}`);
  console.log(`  config         ${config.toBase58()}`);
  console.log(`  base mint      ${baseMint.publicKey.toBase58()}`);
  console.log(`  pool           ${pool.toBase58()}`);
  console.log(`  name / symbol  ${name} / ${symbol}`);
  console.log(`  uri            ${uri}`);
  console.log(`  transfer hook  ${HOOK_PROGRAM_ID.toBase58()} (NYSE hours)`);

  if (!execute) { console.log("\nDry run. Add --execute to send."); return; }

  const tx = await client.creator.createPoolWithTransferHook({
    baseMint: baseMint.publicKey,
    config,
    name, symbol, uri,
    payer: wallet.publicKey,
    poolCreator: wallet.publicKey,
    transferHookProgram: HOOK_PROGRAM_ID,
  });
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet, baseMint]);
  console.log("\npool created:", sig);

  // Must happen before anyone can trade.
  const initSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(initHookStateIx(baseMint.publicKey, wallet.publicKey)),
    [wallet]
  );
  console.log("hook state initialised:", initSig);

  const [extraMetas] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), baseMint.publicKey.toBuffer()],
    HOOK_PROGRAM_ID
  );
  const check = await connection.getAccountInfo(extraMetas);
  if (!check) throw new Error("hook validation state missing -- the token is NOT tradeable");
  console.log("verified tradeable: validation state exists at", extraMetas.toBase58());
  console.log("mint:", baseMint.publicKey.toBase58());
  console.log("pool:", pool.toBase58());
  fs.writeFileSync(`dbc-token-${baseMint.publicKey.toBase58().slice(0, 8)}.json`, JSON.stringify({
    cluster, config: config.toBase58(), mint: baseMint.publicKey.toBase58(),
    pool: pool.toBase58(), name, symbol, uri,
    transferHookProgram: HOOK_PROGRAM_ID.toBase58(), launchedAt: new Date().toISOString(),
  }, null, 2) + "\n");
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
