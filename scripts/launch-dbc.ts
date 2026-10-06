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
import { NATIVE_MINT, getMint, TOKEN_2022_PROGRAM_ID, getExtensionTypes } from "@solana/spl-token";
import { market, MARKETS } from "./markets/presets";
import { QUOTES, resolveQuote } from "./markets/quotes";
import {
  initializeScheduleIx, extraAccountMetasAddress, initializeRegistryIx, registryAddress,
} from "./markets/hook";
import { openLedger, sendWithLedger, DEFAULT_LEDGER_PATH, LedgerSigner } from "./markets/ledger";
import {
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
  deriveTokenBadgeAddress,
  buildCurve as buildCurveFromThreshold,
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
 * Where the platform's share of every trade goes.
 *
 * This is written into the DBC config at creation and CANNOT be changed: the
 * program has no instruction for it (transfer_pool_creator moves the creator
 * side, but nothing moves the fee claimer). Every token launched on a config
 * pays its platform fee here forever.
 *
 * Claiming requires this address to SIGN, so it has to be a wallet whose key
 * you hold -- not a PDA, not a multisig you cannot sign for, and not a hot
 * wallet you intend to throw away.
 */
const PLATFORM_FEE_CLAIMER = new PublicKey("FTnprQrxXRGBAJRg8axCbocBNeSvQC3YoCFqEE8khJ3c");

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

const SUPPLY = 1_000_000_000; // whole tokens
const BASE_DECIMALS = 6;

/**
 * Build the curve for a given quote mint.
 *
 * sqrtStartPrice, the curve points and the migration threshold are all
 * denominated in the QUOTE token, so they cannot be shared between a 9-decimal
 * SOL pool and an 8-decimal stock token. The SDK derives a consistent set from
 * market caps; DBC rejects a config whose curve and threshold disagree.
 *
 * The migration cap is the lever that decides whether the hours are permanent.
 * DBC strips the transfer hook when a curve completes, so a reachable cap means
 * the trading-hours restriction ends. Default it absurdly high.
 */
/** Meteora fee numerators are out of 1e9; bps are out of 1e4. */
function feeBps(cliffFeeNumerator: number): number {
  const bps = cliffFeeNumerator / 100_000;
  if (!Number.isInteger(bps)) throw new Error(`fee numerator ${cliffFeeNumerator} is not a whole number of bps`);
  return bps;
}

function buildCurveConfig(opts: {
  quoteDecimals: number;
  /** Quote tokens that must flow in before the curve completes. */
  migrationThreshold: number;
  /** Share of supply handed to the migrated pool; the rest sells on the curve. */
  supplyOnMigrationPct: number;
  cliffFeeNumerator: number;
  creatorSharePct: number;
}) {
  return buildCurveFromThreshold({
    token: {
      tokenType: 1, // Token-2022, required for a transfer hook
      tokenBaseDecimal: BASE_DECIMALS,
      tokenQuoteDecimal: opts.quoteDecimals,
      tokenAuthorityOption: 1, // Immutable
      totalTokenSupply: SUPPLY,
      leftover: 0,
    },
    // The builder takes the fee in BPS and validates it; configParameters()
    // later overwrites poolFees with the raw on-chain shape. A flat fee is a
    // linear schedule with start == end and no periods.
    fee: {
      baseFeeParams: {
        baseFeeMode: 0, // FeeSchedulerLinear
        feeSchedulerParam: {
          startingFeeBps: feeBps(opts.cliffFeeNumerator),
          endingFeeBps: feeBps(opts.cliffFeeNumerator),
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: 0, // QuoteToken
      creatorTradingFeePercentage: opts.creatorSharePct,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: 1, // DAMM v2
      migrationFeeOption: 2, // FixedBps100
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: { collectFeeMode: 0, dynamicFee: 0, poolFeeBps: 0 },
    },
    // These four must sum to 100 and the names must be exactly these: the
    // builder reads them off the object and silently emits `undefined` for any
    // it does not recognise, which only surfaces later as "Sum of LP
    // percentages must equal 100" from the config validator.
    // All of it is permanently locked -- nobody can pull the migrated LP.
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
    },
    // No vesting. These are the builder's HIGH-LEVEL inputs, not the
    // already-computed on-chain shape: it derives amountPerPeriod itself and
    // short-circuits cleanly only when totalLockedVestingAmount is 0.
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: 1, // timestamp
    // Deliberately NOT buildCurveWithMarketCap: deriving the threshold from a
    // pair of market caps leaves a rounding residual that makes it throw
    // "Not enough liquidity" for many perfectly sensible cap pairs, and the
    // threshold -- not the cap -- is the number that decides whether the
    // trading hours are permanent. Naming it directly is exact at both the
    // 9-decimal (SOL) and 8-decimal (xStock) scales.
    percentageSupplyOnMigration: opts.supplyOnMigrationPct,
    migrationQuoteThreshold: opts.migrationThreshold,
  } as any);
}

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

/**
 * Refuse an address that could never claim what is assigned to it.
 *
 * Both the fee claimer and the pool creator have to sign to collect, and both
 * are effectively permanent. The failure mode is silent -- fees accrue
 * normally and simply cannot be withdrawn -- so the checks happen up front.
 */
async function assertClaimable(
  connection: Connection,
  addr: PublicKey,
  signer: Signer,
  role: string,
  flag: string
) {
  // Off-curve addresses are PDAs. A PDA has no secret key, so nothing can ever
  // produce its signature.
  if (!PublicKey.isOnCurve(addr.toBytes())) {
    throw new Error(
      `${role} ${addr.toBase58()} is off-curve (a PDA).\n` +
        `  Claiming needs its signature, which no one can produce. Use a wallet address.`
    );
  }
  const info = await connection.getAccountInfo(addr);
  if (info && !info.owner.equals(SystemProgram.programId)) {
    throw new Error(
      `${role} ${addr.toBase58()} is owned by ${info.owner.toBase58()}, not the System Program.\n` +
        `  That is a program or token account, not a wallet, and it cannot sign a claim.`
    );
  }
  // A file keypair is a hot wallet. Assigning permanent fee income to the key
  // that happens to be running the script is almost never deliberate.
  if (!signer.isLedger && addr.equals(signer.publicKey)) {
    if (!process.argv.includes("--allow-hot-fee-claimer")) {
      throw new Error(
        `${role} is the hot wallet signing this (${addr.toBase58()}).\n` +
          `  This is permanent. If that key is a throwaway, the income is gone with it.\n` +
          `  Pass ${flag} <your wallet>, or --allow-hot-fee-claimer if you mean it.`
      );
    }
    console.log(`  NOTE: ${role} is the signing hot wallet, allowed explicitly.`);
  }
}

function configParameters(
  feeClaimer: PublicKey,
  tier: TierId,
  curve: any
) {
  const t = FEE_TIERS[tier];
  return {
    ...curve,
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
    creatorTradingFeePercentage: t.creatorSharePct,
    tokenUpdateAuthority: 1, // Immutable: name, symbol and uri can never change
    partnerLiquidityVestingInfo: NO_LIQUIDITY_VESTING,
    creatorLiquidityVestingInfo: NO_LIQUIDITY_VESTING,
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams:
      DEFAULT_MIGRATED_POOL_MARKET_CAP_FEE_SCHEDULER_PARAMS,
  } as any;
}

async function main() {
  const cmd = process.argv[2];
  if (!["config", "token", "claim", "registry"].includes(cmd)) {
    throw new Error(
      `usage: launch-dbc.ts <config|token|claim|registry> [...]\n` +
        `  --market <${Object.keys(MARKETS).join("|")}>\n` +
        `  --tier   <${Object.keys(FEE_TIERS).join("|")}>  (creator's cut; you always net ~1%)\n` +
        `  --quote  <${Object.keys(QUOTES).join("|")}>  (or --quote-mint <ADDRESS>)\n` +
        `  --threshold <QUOTE TOKENS>  graduation point; keep it unreachable (default 100000)\n` +
        `  --fee-claimer <ADDRESS>  platform fee destination (permanent; default the Ledger)\n` +
        `  --ledger [--ledger-path "44'/501'/0'/0'"] [--expect <ADDRESS>]`
    );
  }
  const cluster = arg("cluster", "devnet") as "devnet" | "mainnet-beta";
  const execute = process.argv.includes("--execute");
  // --ledger signs on the device; otherwise a keypair file is used.
  const useLedger = process.argv.includes("--ledger");
  const ledgerPath = arg("ledger-path", DEFAULT_LEDGER_PATH);
  // Default the expected device address to the launch Ledger, so a wrong
  // derivation path is caught before anything is signed rather than producing
  // a confusing failure further in.
  const expectAddr = (() => {
    const i = process.argv.indexOf("--expect");
    if (i !== -1 && process.argv[i + 1]) return new PublicKey(process.argv[i + 1]);
    return PLATFORM_FEE_CLAIMER;
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
    // Defaults to the Ledger, NOT to whatever signed this. Defaulting to the
    // signer is how platform fees end up permanently assigned to a throwaway
    // hot key.
    const feeClaimer = new PublicKey(arg("fee-claimer", PLATFORM_FEE_CLAIMER.toBase58()));
    await assertClaimable(connection, feeClaimer, signer, "fee claimer", "--fee-claimer");
    const tier = arg("tier", "1") as TierId;
    if (!(tier in FEE_TIERS)) {
      throw new Error(`unknown --tier '${tier}'. choose ${Object.keys(FEE_TIERS).join(", ")}`);
    }
    const split = tierSplit(FEE_TIERS[tier]);
    const config = Keypair.generate();

    // Pair against SOL by default, or any quote mint DBC accepts -- a tokenised
    // stock, for instance. Its decimals feed the curve, so they must be read
    // from chain rather than assumed.
    // --quote takes a symbol from the pair list (SOL, QQQx, TSLAx, ...);
    // --quote-mint takes a raw address for anything not in it.
    const quoteSpec = arg("quote-mint", "") || arg("quote", "SOL");
    const resolved = resolveQuote(quoteSpec);
    const quoteMint = new PublicKey(resolved.mint);
    const quoteInfo = await connection.getAccountInfo(quoteMint);
    if (!quoteInfo) throw new Error(`quote mint ${quoteMint.toBase58()} not found on ${cluster}`);
    const isToken2022Quote = quoteInfo.owner.equals(TOKEN_2022_PROGRAM_ID);
    const quote = await getMint(connection, quoteMint, "confirmed", quoteInfo.owner);
    const quoteLabel = resolved.symbol;
    // A preset that has drifted from the chain would silently build the curve
    // at the wrong scale, so the presets are checked rather than trusted.
    if (resolved.decimals !== undefined && resolved.decimals !== quote.decimals) {
      throw new Error(
        `${quoteLabel} preset says ${resolved.decimals} decimals but the mint has ${quote.decimals}. ` +
          `Re-run scripts/check-quotes.ts.`
      );
    }

    // A Token-2022 quote mint with extensions is not permissionless on DBC and
    // needs a quote-mint token badge, passed as a remaining account.
    let quoteBadge: PublicKey | undefined;
    if (isToken2022Quote) {
      const badge = deriveTokenBadgeAddress(quoteMint);
      const exists = await connection.getAccountInfo(badge);
      if (!exists) {
        throw new Error(
          `${quoteLabel} has no DBC quote-mint token badge (${badge.toBase58()}).\n` +
            "  Meteora has to issue one before it can be used as a quote mint."
        );
      }
      quoteBadge = badge;
    }

    const migrationThreshold = Number(arg("threshold", "100000"));
    const supplyOnMigrationPct = Number(arg("supply-on-migration", "20"));
    const curve = buildCurveConfig({
      quoteDecimals: quote.decimals,
      migrationThreshold,
      supplyOnMigrationPct,
      cliffFeeNumerator: FEE_TIERS[tier].cliffFeeNumerator,
      creatorSharePct: FEE_TIERS[tier].creatorSharePct,
    });
    // The builder returns `undefined` rather than throwing when it does not
    // recognise an input field, so check its output instead of trusting it.
    const lp = [
      "partnerPermanentLockedLiquidityPercentage", "partnerLiquidityPercentage",
      "creatorPermanentLockedLiquidityPercentage", "creatorLiquidityPercentage",
    ] as const;
    const missing = lp.filter((k) => (curve as any)[k] === undefined);
    if (missing.length) throw new Error(`curve builder did not set ${missing.join(", ")}`);
    const lpSum = lp.reduce((n, k) => n + Number((curve as any)[k]), 0);
    if (lpSum !== 100) throw new Error(`LP percentages sum to ${lpSum}, not 100`);

    const threshold = Number(curve.migrationQuoteThreshold) / 10 ** quote.decimals;
    if (threshold !== migrationThreshold) {
      throw new Error(`asked for a ${migrationThreshold} threshold, curve encodes ${threshold}`);
    }

    console.log("Create DBC partner config");
    console.log(`  endpoint       ${endpoint}`);
    console.log(`  payer          ${wallet.publicKey.toBase58()}`);
    console.log(`  config         ${config.publicKey.toBase58()}`);
    console.log(`  fee claimer    ${feeClaimer.toBase58()}  <-- receives the platform fee`);
    console.log(`                 PERMANENT: no instruction can change this later.`);
    console.log(`                 ${
      feeClaimer.equals(signer.publicKey)
        ? "This is the signer, so you can claim with the same key."
        : "Claiming needs THIS key to sign, not the key creating the config."
    }`);
    console.log(`  quote mint     ${quoteLabel}${isToken2022Quote ? " (Token-2022)" : ""}`);
    console.log(`  quote decimals ${quote.decimals}`);
    if (quoteBadge) console.log(`  quote badge    ${quoteBadge.toBase58()}`);
    console.log(`  transfer hook  ${HOOK_PROGRAM_ID.toBase58()}`);
    console.log(`  fee tier       ${tier}% creator`);
    console.log(`  trading fee    ${split.total.toFixed(2)}% of every buy and sell`);
    console.log(`    creator gets ${split.creator.toFixed(3)}%`);
    console.log(`    you get      ${split.platform.toFixed(3)}%`);
    console.log(`    Meteora gets ${(split.total * 0.2).toFixed(3)}% (20% protocol fee)`);
    console.log(`  supply on migration ${supplyOnMigrationPct}% (the rest sells on the curve)`);
    console.log(`  graduates at   ${threshold.toLocaleString()} ${quoteLabel}`);
    console.log(`                 DBC strips the hook when a curve completes, which would`);
    console.log(`                 end the trading hours. Keep this out of reach.`);
    console.log(`  supply         ${SUPPLY.toLocaleString()} at ${BASE_DECIMALS} decimals`);

    if (!execute) { console.log("\nDry run. Add --execute to send."); return; }

    const hook = await connection.getAccountInfo(HOOK_PROGRAM_ID);
    if (!hook?.executable) throw new Error(`hook program is not deployed on ${cluster}`);

    const tx = await client.partner.createConfigWithTransferHook({
      ...configParameters(feeClaimer, tier, curve),
      config: config.publicKey,
      feeClaimer,
      leftoverReceiver: feeClaimer,
      payer: wallet.publicKey,
      quoteMint,
      transferHookProgram: HOOK_PROGRAM_ID,
      ...(quoteBadge ? { tokenBadge: quoteBadge } : {}),
    });
    const sig = await signer.send(connection, tx, [config]);
    console.log("\nconfig created:", sig);
    console.log("config address:", config.publicKey.toBase58());
    const outName = `dbc-config-${cluster}-${quoteLabel}-${tier}.json`;
    fs.writeFileSync(outName, JSON.stringify({
      cluster, tier, config: config.publicKey.toBase58(), feeClaimer: feeClaimer.toBase58(),
      quoteMint: quoteMint.toBase58(), quoteDecimals: quote.decimals, quoteSymbol: quoteLabel,
      migrationThreshold: threshold,
      transferHookProgram: HOOK_PROGRAM_ID.toBase58(),
      totalFeePct: split.total, creatorPct: split.creator, platformPct: split.platform,
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n");
    console.log(`wrote ${outName} -- reuse for every token on this tier and quote`);
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
    const quoteFee = as === "creator" ? ps.creatorQuoteFee : ps.partnerQuoteFee;
    const base = as === "creator" ? ps.creatorBaseFee : ps.partnerBaseFee;

    // Fees accrue in the QUOTE token, which is only SOL when the pool was
    // configured that way. Read the mint off the pool's config rather than
    // assuming 9 decimals -- an xStock quote has 8, and the claim would be
    // reported ten times too small under the wrong label.
    const poolCfg: any = await client.state.getPoolConfig(ps.config);
    const quoteMint: PublicKey = (poolCfg.configState ?? poolCfg).quoteMint;
    const known = Object.values(QUOTES).find((q) => q.mint === quoteMint.toBase58());
    const quoteInfo = await connection.getAccountInfo(quoteMint);
    const quoteDecimals = (await getMint(connection, quoteMint, "confirmed", quoteInfo!.owner)).decimals;
    const quoteLabel = known?.symbol ?? quoteMint.toBase58();

    console.log(`claim ${as} fees`);
    console.log(`  pool       ${pool.toBase58()}`);
    console.log(`  claimer    ${wallet.publicKey.toBase58()}`);
    console.log(`  receiver   ${receiver.toBase58()}`);
    console.log(`  quote      ${quoteLabel} (${quoteDecimals} decimals)`);
    console.log(`  claimable  ${(Number(quoteFee) / 10 ** quoteDecimals).toFixed(quoteDecimals)} ${quoteLabel} + ${base} base units`);

    if (Number(quoteFee) === 0 && Number(base) === 0) {
      console.log("\nNothing to claim.");
      return;
    }
    if (!execute) { console.log("\nDry run. Add --execute to send."); return; }

    const params = {
      payer: wallet.publicKey, pool, receiver,
      maxBaseAmount: base, maxQuoteAmount: quoteFee,
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
  const creator = new PublicKey(arg("creator", PLATFORM_FEE_CLAIMER.toBase58()));
  await assertClaimable(connection, creator, signer, "pool creator", "--creator");
  const baseMint = Keypair.generate();
  // Read the quote mint off the config rather than assuming SOL: the pool
  // address is derived from it, and a wrong guess derives a different pool.
  const cfgState = await client.state.getPoolConfig(config);
  if (!cfgState) throw new Error(`no DBC config at ${config.toBase58()}`);
  const cfgQuote = ((cfgState as any).configState ?? cfgState).quoteMint as PublicKey;
  const pool = deriveDbcPoolAddress(cfgQuote, baseMint.publicKey, config);

  console.log("Launch token on your DBC config");
  console.log(`  endpoint       ${endpoint}`);
  console.log(`  config         ${config.toBase58()}`);
  const cfgQuoteLabel =
    Object.values(QUOTES).find((q) => q.mint === cfgQuote.toBase58())?.symbol ?? cfgQuote.toBase58();

  // A Token-2022 quote mint needs its DBC token badge here as well as at
  // config creation -- pool creation re-checks it and fails with
  // InvalidTokenBadge (6080) otherwise.
  const cfgQuoteInfo = await connection.getAccountInfo(cfgQuote);
  if (!cfgQuoteInfo) throw new Error(`quote mint ${cfgQuote.toBase58()} not found`);
  let tokenBadge: PublicKey | undefined;
  if (cfgQuoteInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    const badge = deriveTokenBadgeAddress(cfgQuote);
    if (!(await connection.getAccountInfo(badge))) {
      throw new Error(`${cfgQuoteLabel} has no DBC token badge (${badge.toBase58()})`);
    }
    tokenBadge = badge;
  }

  console.log(`  quote mint     ${cfgQuoteLabel}`);
  if (tokenBadge) console.log(`  quote badge    ${tokenBadge.toBase58()}`);
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

  if (!creator.equals(signer.publicKey)) {
    throw new Error(
      `--creator ${creator.toBase58()} must sign this transaction, but the signer is ` +
        `${signer.publicKey.toBase58()}.\n` +
        `  Run this with the creator's own key (--ledger, or ANCHOR_WALLET), or drop --creator.`
    );
  }

  if (!execute) { console.log("\nDry run. Add --execute to send."); return; }

  const tx = await client.creator.createPoolWithTransferHook({
    baseMint: baseMint.publicKey,
    config,
    name, symbol, uri,
    payer: wallet.publicKey,
    poolCreator: creator,
    transferHookProgram: HOOK_PROGRAM_ID,
    ...(tokenBadge ? { tokenBadge } : {}),
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
