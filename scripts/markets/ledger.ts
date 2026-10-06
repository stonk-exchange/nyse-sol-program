/**
 * Sign transactions with a Ledger.
 *
 * The scripts otherwise load a keypair from a file, which cannot be done for a
 * hardware wallet. This signs the transaction message on the device instead, so
 * the key never leaves it.
 *
 * Derivation path: the Solana CLI's `usb://ledger?key=N` maps to 44'/501'/N'
 * -- THREE levels, not four. `usb://ledger?key=N/M` is the four-level
 * 44'/501'/N'/M'. They are different accounts on the same device: this repo
 * previously defaulted to the four-level form, which on the launch Ledger is a
 * different, empty address.
 *
 * Confirmed by querying the device at both paths. If the address that comes
 * back is not the one you expect, the path is wrong -- pass --ledger-path
 * rather than guessing, and never proceed on a mismatch.
 */
import TransportNodeHid from "@ledgerhq/hw-transport-node-hid";
import Solana from "@ledgerhq/hw-app-solana";
import { PublicKey, Transaction, Connection } from "@solana/web3.js";

export const DEFAULT_LEDGER_PATH = "44'/501'/0'";

export type LedgerSigner = {
  publicKey: PublicKey;
  /** Sign in place, appending the device's signature to the transaction. */
  sign(tx: Transaction): Promise<Transaction>;
  close(): Promise<void>;
};

/**
 * Open the device and confirm which account it will sign as.
 *
 * `expect` is the address you believe the device holds. It is compared before
 * anything is signed, because signing with the wrong derivation path would put
 * a permanent authority or fee claimer on an address you do not control.
 */
export async function openLedger(
  path = DEFAULT_LEDGER_PATH,
  expect?: PublicKey
): Promise<LedgerSigner> {
  const transport = await TransportNodeHid.create().catch((e: any) => {
    throw new Error(
      `cannot reach a Ledger: ${e.message}\n` +
        "  - plug it in, unlock it, and open the Solana app\n" +
        "  - close any other app using it (Ledger Live, a browser wallet)"
    );
  });
  const app = new Solana(transport);

  // Reading the address is the first thing that touches the device, so this is
  // where a locked screen or a closed Solana app surfaces.
  let address: Buffer;
  try {
    ({ address } = await app.getAddress(path));
  } catch (e: any) {
    await transport.close().catch(() => {});
    const msg = String(e?.message ?? e);
    if (/0x5515|locked/i.test(msg)) {
      throw new Error("Ledger is locked. Unlock it, open the Solana app, and retry.");
    }
    if (/0x6d02|0x6e00|0x6511|not open|INS_NOT_SUPPORTED/i.test(msg)) {
      throw new Error("The Solana app is not open on the Ledger. Open it and retry.");
    }
    if (/0x6985|denied|rejected/i.test(msg)) {
      throw new Error("Request was rejected on the device.");
    }
    throw new Error(`Ledger error while reading the address: ${msg}`);
  }
  const publicKey = new PublicKey(address);

  if (expect && !publicKey.equals(expect)) {
    await transport.close();
    throw new Error(
      `Ledger at ${path} is ${publicKey.toBase58()}, expected ${expect.toBase58()}.\n` +
        "  Wrong derivation path or wrong device. Try --ledger-path \"44'/501'/0'\"\n" +
        "  (some wallets omit the final component). Not proceeding."
    );
  }

  return {
    publicKey,
    async sign(tx: Transaction) {
      // The device signs the compiled message, which must already carry the
      // fee payer and a recent blockhash.
      const message = tx.compileMessage().serialize();
      let signature: Buffer;
      try {
        ({ signature } = await app.signTransaction(path, message));
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (/0x6985|denied|rejected/i.test(msg)) {
          throw new Error("You rejected the transaction on the Ledger. Nothing was sent.");
        }
        if (/0x5515|locked/i.test(msg)) {
          throw new Error("Ledger locked mid-signing. Unlock it and retry; nothing was sent.");
        }
        throw new Error(`Ledger refused to sign: ${msg}`);
      }
      tx.addSignature(publicKey, signature);
      return tx;
    },
    async close() {
      await transport.close();
    },
  };
}

/** Sign with the device and send, printing what the device is being asked to approve. */
export async function sendWithLedger(
  connection: Connection,
  tx: Transaction,
  signer: LedgerSigner,
  extraSigners: { publicKey: PublicKey; secretKey: Uint8Array }[] = []
): Promise<string> {
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;

  // Any keypairs that must also sign (a new mint, for instance) sign first, so
  // the device sees the final message.
  for (const kp of extraSigners) tx.partialSign(kp as any);

  console.log("\n  >>> CONFIRM ON THE LEDGER <<<");
  console.log(`      signing as ${signer.publicKey.toBase58()}`);
  console.log(`      ${tx.instructions.length} instruction(s)`);
  await signer.sign(tx);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}
