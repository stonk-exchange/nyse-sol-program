/**
 * Launch a NYSE-hours-locked Token-2022 mint with on-chain metadata.
 *
 * This produces a launchpad-style token: name, symbol and image resolve in
 * wallets, explorers and DEX aggregators, and every transfer of the mint is
 * gated on NYSE market hours by the transfer hook.
 *
 * It mints the entire supply once and then permanently revokes everything that
 * could later change the rules:
 *
 *   - mint authority       -> null   supply can never increase
 *   - freeze authority     -> null   nobody can freeze or thaw a holder
 *   - transfer hook auth   -> null   the hook can never be repointed
 *   - metadata update auth -> null   name/symbol/image can never be changed
 *
 * After this runs the only remaining centralised power is the *program* upgrade
 * authority, which lives outside the mint. Burn it separately:
 *
 *   solana program set-upgrade-authority <PROGRAM_ID> --final
 *
 * Usage:
 *   ANCHOR_WALLET=~/.config/solana/id.json npx ts-node scripts/launch-token.ts \
 *     --cluster devnet --name "STONKS" --symbol STONKS \
 *     --uri https://example.com/metadata.json --supply 1000000 --decimals 9
 *
 * Add --execute to actually send transactions. Without it the script prints the
 * plan and exits.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AuthorityType,
  ExtensionType,
  LENGTH_SIZE,
  TYPE_SIZE,
  getMintLen,
  getMint,
  getTransferHook,
  getTokenMetadata,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  createInitializeMetadataPointerInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  pack,
  createInitializeInstruction,
  createUpdateAuthorityInstruction,
  type TokenMetadata,
} from "@solana/spl-token-metadata";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";

const HOOK_PROGRAM_ID = new PublicKey("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

function loadWallet(): Keypair {
  const path = (process.env.ANCHOR_WALLET ?? `${os.homedir()}/.config/solana/id.json`).replace(
    /^~/,
    os.homedir()
  );
  if (!fs.existsSync(path)) throw new Error(`wallet not found at ${path}; set ANCHOR_WALLET`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

async function main() {
  const cluster = arg("cluster", "devnet") as "devnet" | "testnet" | "mainnet-beta";
  const decimals = Number(arg("decimals", "9"));
  const supplyWhole = BigInt(arg("supply", "1000000"));
  const name = arg("name");
  const symbol = arg("symbol");
  const uri = arg("uri");
  const execute = process.argv.includes("--execute");

  const supply = supplyWhole * 10n ** BigInt(decimals);
  const wallet = loadWallet();
  const mint = Keypair.generate();
  const connection = new Connection(clusterApiUrl(cluster), "confirmed");

  const [extraMetas] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
    HOOK_PROGRAM_ID
  );
  const treasury = getAssociatedTokenAddressSync(
    mint.publicKey,
    wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // Metadata lives on the mint itself, so the pointer targets the mint.
  const metadata: TokenMetadata = {
    updateAuthority: wallet.publicKey,
    mint: mint.publicKey,
    name,
    symbol,
    uri,
    additionalMetadata: [["trading_hours", "NYSE 09:30-16:00 ET, Mon-Fri"]],
  };

  const extensions = [ExtensionType.TransferHook, ExtensionType.MetadataPointer];
  const mintLen = getMintLen(extensions);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;

  console.log("NYSE-locked token launch");
  console.log(`  cluster        ${cluster}`);
  console.log(`  payer          ${wallet.publicKey.toBase58()}`);
  console.log(`  mint           ${mint.publicKey.toBase58()}`);
  console.log(`  name / symbol  ${name} / ${symbol}`);
  console.log(`  uri            ${uri}`);
  console.log(`  hook program   ${HOOK_PROGRAM_ID.toBase58()}`);
  console.log(`  validation PDA ${extraMetas.toBase58()}`);
  console.log(`  treasury ATA   ${treasury.toBase58()}`);
  console.log(`  supply         ${supplyWhole} (${supply} base units, ${decimals} decimals)`);
  console.log(`  account size   ${mintLen} + ${metadataLen} metadata`);
  console.log("  after launch   mint / freeze / hook / metadata authorities all revoked");

  if (!execute) {
    console.log("\nDry run. Re-run with --execute to send these transactions.");
    return;
  }

  const hookCode = await connection.getAccountInfo(HOOK_PROGRAM_ID);
  if (!hookCode?.executable) {
    throw new Error(`hook program is not deployed on ${cluster}; run 'anchor deploy' first`);
  }

  // 1. Create the mint. The account is sized for the fixed extensions but funded
  //    for the variable-length metadata too, which InitializeTokenMetadata
  //    reallocates into. Extension init order matters: pointers and the hook
  //    before InitializeMint, token metadata after it.
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);
  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(
      mint.publicKey,
      wallet.publicKey,
      mint.publicKey, // metadata stored on the mint itself
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeTransferHookInstruction(
      mint.publicKey,
      wallet.publicKey,
      HOOK_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      wallet.publicKey,
      null, // no freeze authority, ever
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint.publicKey,
      updateAuthority: wallet.publicKey,
      mint: mint.publicKey,
      mintAuthority: wallet.publicKey,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
    })
  );
  console.log(
    "\n1/3 creating mint with metadata:",
    await sendAndConfirmTransaction(connection, createMintTx, [wallet, mint])
  );

  // 2. Initialize the hook's validation state. Transfers fail without this.
  const initTx = new Transaction().add({
    programId: HOOK_PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: extraMetas, isSigner: false, isWritable: true },
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator("initialize_extra_account_meta_list"),
  });
  console.log(
    "2/3 initializing hook state:",
    await sendAndConfirmTransaction(connection, initTx, [wallet])
  );

  // 3. Mint the whole supply, then revoke everything, in one transaction so the
  //    mint is never left in a state where a later signer could inflate it.
  const lockTx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      treasury,
      wallet.publicKey,
      mint.publicKey,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
    createMintToInstruction(
      mint.publicKey,
      treasury,
      wallet.publicKey,
      supply,
      [],
      TOKEN_2022_PROGRAM_ID
    ),
    createUpdateAuthorityInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint.publicKey,
      oldAuthority: wallet.publicKey,
      newAuthority: null,
    }),
    createSetAuthorityInstruction(
      mint.publicKey,
      wallet.publicKey,
      AuthorityType.MintTokens,
      null,
      [],
      TOKEN_2022_PROGRAM_ID
    ),
    createSetAuthorityInstruction(
      mint.publicKey,
      wallet.publicKey,
      AuthorityType.TransferHookProgramId,
      null,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );
  console.log(
    "3/3 minting supply and revoking authorities:",
    await sendAndConfirmTransaction(connection, lockTx, [wallet])
  );

  // Read the mint back and verify, rather than trusting the sends succeeded.
  const info = await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  const hook = getTransferHook(info);
  const onChainMeta = await getTokenMetadata(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);

  const checks: [string, boolean][] = [
    ["supply matches", info.supply === supply],
    ["mint authority revoked", info.mintAuthority === null],
    ["freeze authority revoked", info.freezeAuthority === null],
    ["transfer hook set to our program", hook?.programId.equals(HOOK_PROGRAM_ID) === true],
    // A revoked hook authority decodes as the all-zeros pubkey rather than
    // null, unlike the mint and freeze authorities. Accept either.
    [
      "transfer hook authority revoked",
      hook !== null && (hook.authority === null || hook.authority.equals(PublicKey.default)),
    ],
    ["metadata name matches", onChainMeta?.name === name],
    ["metadata symbol matches", onChainMeta?.symbol === symbol],
    ["metadata uri matches", onChainMeta?.uri === uri],
    [
      "metadata update authority revoked",
      onChainMeta != null &&
        (onChainMeta.updateAuthority === undefined ||
          onChainMeta.updateAuthority.equals(PublicKey.default)),
    ],
  ];

  console.log("\nverification:");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
    ok &&= pass;
  }

  fs.writeFileSync(
    `launch-${cluster}.json`,
    JSON.stringify(
      {
        cluster,
        mint: mint.publicKey.toBase58(),
        hookProgram: HOOK_PROGRAM_ID.toBase58(),
        extraAccountMetaList: extraMetas.toBase58(),
        treasury: treasury.toBase58(),
        name,
        symbol,
        uri,
        decimals,
        supply: supply.toString(),
        authoritiesRevoked: { mint: true, freeze: true, transferHook: true, metadata: true },
        launchedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );
  console.log(`\nwrote launch-${cluster}.json`);

  if (!ok) {
    console.error("\nverification FAILED - do not distribute this mint");
    process.exit(1);
  }
  console.log("\nRemaining centralised power: the hook program's upgrade authority.");
  console.log(`  solana program set-upgrade-authority ${HOOK_PROGRAM_ID.toBase58()} --final`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
