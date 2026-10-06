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
import { NATIVE_MINT } from "@solana/spl-token";
import { market, MARKETS } from "./markets/presets";
import {
  initializeScheduleIx, extraAccountMetasAddress, initializeRegistryIx, registryAddress,
} from "./markets/hook";
import { openLedger, sendWithLedger, DEFAULT_LEDGER_PATH, LedgerSigner } from "./markets/ledger";
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
/**
 * Fee tiers the creator chooses from.
 *
 * Meteora takes 20% of every trading fee as protocol fee, and the remaining
 * 80% is split between the partner (us) and the creator. Each tier is sized so
 * the PLATFORM always nets ~1% of volume, whatever the creator takes:
 *
 *   total x (1 - creatorShare) x 0.8 = 1%
 *
 * so a bigger creator cut means a bigger total fee, not a smaller one for us.
 * Each tier is a separate DBC config, created once and reused forever.
 */
export const FEE_TIERS = {
  "0.5": { cliffFeeNumerator: 18_700_000, creatorSharePct: 33 },
  "1":   { cliffFeeNumerator: 25_000_000, creatorSharePct: 50 },
  "2":   { cliffFeeNumerator: 37_900_000, creatorSharePct: 67 },
} as const;

type TierId = keyof typeof FEE_TIERS;

/** What each side actually receives, after Meteora's 20% protocol cut. */
function tierSplit(t: { cliffFeeNumerator: number; creatorSharePct: number }) {
  const total = t.cliffFeeNumerator / 1e7;
  return {
    total,
    creator: total * (t.creatorSharePct / 100) * 0.8,
    platform: total * ((100 - t.creatorSharePct) / 100) * 0.8,
  };
}

const CURVE = {
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

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

/**
 * Either a keypair from a file or a Ledger. The device cannot hand over a
 * secret key, so sending goes through a function rather than a Keypair.
 */
type Signer = {
  publicKey: PublicKey;
  send(connection: Connection, tx: Transaction, extra?: Keypair[]): Promise<string>;
  close(): Promise<void>;
  isLedger: boolean;
};

function fileSigner(kp: Keypair): Signer {
  return {
    publicKey: kp.publicKey,
    isLedger: false,
    async send(connection, tx, extra = []) {
      return sendAndConfirmTransaction(connection, tx, [kp, ...extra]);
    },
    async close() {},
  };
}

function ledgerSigner(l: LedgerSigner): Signer {
  return {
    publicKey: l.publicKey,
    isLedger: true,
    async send(connection, tx, extra = []) {
      return sendWithLedger(connection, tx, l, extra as any);
    },
    close: l.close,
  };
}

function loadWallet(): Keypair {
  const path = (process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`).replace(/^~/, os.homedir());
  if (!fs.existsSync(path)) throw new Error(`wallet not found at ${path}; set ANCHOR_WALLET`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

function configParameters(feeClaimer: PublicKey, tier: TierId) {
  const t = FEE_TIERS[tier];
  return {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: new BN(t.cliffFeeNumerator),
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
    creatorTradingFeePercentage: t.creatorSharePct,
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
  if (!["config", "token", "claim", "registry"].includes(cmd)) {
    throw new Error(
      `usage: launch-dbc.ts <config|token|claim|registry> [...]\n` +
        `  --market <${Object.keys(MARKETS).join("|")}>\n` +
        `  --tier   <${Object.keys(FEE_TIERS).join("|")}>  (creator's cut; you always net ~1%)\n` +
        `  --ledger [--ledger-path "44'/501'/0'/0'"] [--expect <ADDRESS>]`
    );
  }
  const cluster = arg("cluster", "devnet") as "devnet" | "mainnet-beta";
  const execute = process.argv.includes("--execute");
  // --ledger signs on the device; otherwise a keypair file is used.
  const useLedger = process.argv.includes("--ledger");
  const ledgerPath = arg("ledger-path", DEFAULT_LEDGER_PATH);
  const expectAddr = (() => {
    const i = process.argv.indexOf("--expect");
    return i !== -1 && process.argv[i + 1] ? new PublicKey(process.argv[i + 1]) : undefined;
  })();
  const signer: Signer = useLedger
    ? ledgerSigner(await openLedger(ledgerPath, expectAddr))
    : fileSigner(loadWallet());
  const wallet = { publicKey: signer.publicKey };
  // --rpc overrides the cluster endpoint, so the whole flow can be rehearsed
  // against a local validator with the DBC program cloned in.
  const endpoint = arg("rpc", clusterApiUrl(cluster));
  const connection = new Connection(endpoint, "confirmed");
  const client = DynamicBondingCurveClient.create(connection, "confirmed");

  if (cmd === "config") {
    const feeClaimer = new PublicKey(arg("fee-claimer", wallet.publicKey.toBase58()));
    const tier = arg("tier", "1") as TierId;
    if (!(tier in FEE_TIERS)) {
      throw new Error(`unknown --tier '${tier}'. choose ${Object.keys(FEE_TIERS).join(", ")}`);
    }
    const split = tierSplit(FEE_TIERS[tier]);
    const config = Keypair.generate();

    console.log("Create DBC partner config");
    console.log(`  endpoint       ${endpoint}`);
    console.log(`  payer          ${wallet.publicKey.toBase58()}`);
    console.log(`  config         ${config.publicKey.toBase58()}`);
    console.log(`  fee claimer    ${feeClaimer.toBase58()}  <-- receives the trading fee`);
    console.log(`  quote mint     SOL`);
    console.log(`  transfer hook  ${HOOK_PROGRAM_ID.toBase58()}`);
    console.log(`  fee tier       ${tier}% creator`);
    console.log(`  trading fee    ${split.total.toFixed(2)}% of every buy and sell`);
    console.log(`    creator gets ${split.creator.toFixed(3)}%`);
    console.log(`    you get      ${split.platform.toFixed(3)}%`);
    console.log(`    Meteora gets ${(split.total * 0.2).toFixed(3)}% (20% protocol fee)`);
    console.log(`  graduates at   ${(Number(CURVE.migrationQuoteThreshold) / 1e9).toLocaleString()} SOL  <-- deliberately out of reach`);
    console.log(`                 DBC revokes the hook when a curve completes, so a`);
    console.log(`                 reachable threshold would end the trading hours.`);
    console.log(`  supply         1,000,000,000 at ${CURVE.tokenDecimal} decimals`);

    if (!execute) { console.log("\nDry run. Add --execute to send."); return; }

    const hook = await connection.getAccountInfo(HOOK_PROGRAM_ID);
    if (!hook?.executable) throw new Error(`hook program is not deployed on ${cluster}`);

    const tx = await client.partner.createConfigWithTransferHook({
      ...configParameters(feeClaimer, tier),
      config: config.publicKey,
      feeClaimer,
      leftoverReceiver: feeClaimer,
      payer: wallet.publicKey,
      quoteMint: NATIVE_MINT,
      transferHookProgram: HOOK_PROGRAM_ID,
    });
    const sig = await signer.send(connection, tx, [config]);
    console.log("\nconfig created:", sig);
    console.log("config address:", config.publicKey.toBase58());
    fs.writeFileSync(`dbc-config-${cluster}-${tier}.json`, JSON.stringify({
      cluster, tier, config: config.publicKey.toBase58(), feeClaimer: feeClaimer.toBase58(),
      transferHookProgram: HOOK_PROGRAM_ID.toBase58(),
      totalFeePct: split.total, creatorPct: split.creator, platformPct: split.platform,
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n");
    console.log(`wrote dbc-config-${cluster}-${tier}.json -- reuse for every token on this tier`);
    return;
  }

  if (cmd === "registry") {
    // One-off: create the market registry and name its authority.
    //
    // The signer must be REGISTRY_BOOTSTRAP, compiled into the program. Its
    // only power is this one call, and the authority it names takes over
    // immediately -- so point --authority at the Ledger even if a hot key
    // signs here.
    const authority = new PublicKey(arg("authority", wallet.publicKey.toBase58()));
    const registry = registryAddress();

    console.log("create market registry");
    console.log(`  endpoint   ${endpoint}`);
    console.log(`  signer     ${wallet.publicKey.toBase58()}${signer.isLedger ? " (Ledger)" : ""}  (must be REGISTRY_BOOTSTRAP)`);
    console.log(`  registry   ${registry.toBase58()}`);
    console.log(`  authority  ${authority.toBase58()}  <-- may approve markets from now on`);

    if (await connection.getAccountInfo(registry)) {
      console.log("\nRegistry already exists. Nothing to do.");
      return;
    }
    if (!execute) { console.log("\nDry run. Add --execute to send."); return; }

    const sig = await signer.send(
      connection,
      new Transaction().add(initializeRegistryIx(wallet.publicKey, authority))
    );
    console.log("\nregistry created:", sig);
    return;
  }

  if (cmd === "claim") {
    // Trading fees accrue inside the pool and have to be pulled out. The
    // partner's share and the creator's share are separate pots with separate
    // claimers; --as picks which one this wallet is claiming.
    const pool = new PublicKey(arg("pool"));
    const as = arg("as", "partner");
    const receiver = new PublicKey(arg("receiver", wallet.publicKey.toBase58()));

    const state = await client.state.getPool(pool);
    if (!state) throw new Error(`no DBC pool at ${pool.toBase58()}`);
    const ps: any = (state as any).poolState ?? state;
    const quote = as === "creator" ? ps.creatorQuoteFee : ps.partnerQuoteFee;
    const base = as === "creator" ? ps.creatorBaseFee : ps.partnerBaseFee;

    console.log(`claim ${as} fees`);
    console.log(`  pool       ${pool.toBase58()}`);
    console.log(`  claimer    ${wallet.publicKey.toBase58()}`);
    console.log(`  receiver   ${receiver.toBase58()}`);
    console.log(`  claimable  ${(Number(quote) / 1e9).toFixed(6)} SOL + ${base} base units`);

    if (Number(quote) === 0 && Number(base) === 0) {
      console.log("\nNothing to claim.");
      return;
    }
    if (!execute) { console.log("\nDry run. Add --execute to send."); return; }

    const params = {
      payer: wallet.publicKey, pool, receiver,
      maxBaseAmount: base, maxQuoteAmount: quote,
    };
    const tx =
      as === "creator"
        ? await client.creator.claimCreatorTradingFee2({ ...params, creator: wallet.publicKey })
        : await client.partner.claimPartnerTradingFee2({ ...params, feeClaimer: wallet.publicKey });
    console.log("\nclaimed:", await signer.send(connection, tx));
    return;
  }

  // cmd === "token"
  const config = new PublicKey(arg("config"));
  const name = arg("name");
  const symbol = arg("symbol");
  const uri = arg("uri");
  // Which market this token trades on. A market is data, so new ones need no
  // program upgrade; the choice is fixed for the life of the token.
  const marketId = arg("market", "nyse");
  const chosen = market(marketId);
  // The pool creator owns the creator share of trading fees FOREVER. The
  // signer here is a throwaway hot wallet, so defaulting this to the signer
  // would quietly send that share to a key you intend to discard.
  const creator = new PublicKey(arg("creator", wallet.publicKey.toBase58()));
  const baseMint = Keypair.generate();
  const pool = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, config);

  console.log("Launch token on your DBC config");
  console.log(`  endpoint       ${endpoint}`);
  console.log(`  config         ${config.toBase58()}`);
  console.log(`  base mint      ${baseMint.publicKey.toBase58()}`);
  console.log(`  pool           ${pool.toBase58()}`);
  console.log(`  name / symbol  ${name} / ${symbol}`);
  console.log(`  uri            ${uri}`);
  console.log(`  market         ${chosen.label}`);
  console.log(`  transfer hook  ${HOOK_PROGRAM_ID.toBase58()}`);
  console.log(`  pool creator   ${creator.toBase58()}  <-- owns the creator fee share`);
  if (creator.equals(wallet.publicKey)) {
    console.log(`                 WARNING: that is the signing wallet. If this is a`);
    console.log(`                 throwaway hot key, pass --creator <your address>`);
    console.log(`                 or the creator fees are stranded there.`);
  }

  if (!execute) { console.log("\nDry run. Add --execute to send."); return; }

  const tx = await client.creator.createPoolWithTransferHook({
    baseMint: baseMint.publicKey,
    config,
    name, symbol, uri,
    payer: wallet.publicKey,
    poolCreator: creator,
    transferHookProgram: HOOK_PROGRAM_ID,
  });
  const sig = await signer.send(connection, tx, [baseMint]);
  console.log("\npool created:", sig);

  // Must happen before anyone can trade.
  const initSig = await signer.send(
    connection,
    new Transaction().add(initializeScheduleIx(baseMint.publicKey, wallet.publicKey, chosen))
  );
  console.log("schedule + hook state written:", initSig);

  const extraMetas = extraAccountMetasAddress(baseMint.publicKey);
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
