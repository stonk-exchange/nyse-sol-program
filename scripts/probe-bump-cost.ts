/** Does transfer CU depend on the extra-account-metas PDA bump? */
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, getMintLen,
  createInitializeMintInstruction, createInitializeTransferHookInstruction,
  createAssociatedTokenAccountInstruction, createMintToInstruction,
  createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";

const HOOK = new PublicKey("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");
const OPEN = 1_790_607_600n;

const svm = new LiteSVM().withBuiltins().withSplPrograms().withSysvars();
svm.addProgramFromFile(HOOK, "target/deploy/nyse_token_hook.so");
const payer = Keypair.generate();
svm.airdrop(payer.publicKey, 100_000n * 1_000_000_000n);
const c = svm.getClock(); c.unixTimestamp = OPEN; svm.setClock(c);

function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  svm.expireBlockhash();
  const tx = new Transaction();
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  ixs.forEach(i => tx.add(i));
  tx.sign(payer, ...signers);
  return svm.sendTransaction(tx);
}

const samples: { bump: number; cu: number }[] = [];
for (let i = 0; i < 24; i++) {
  const mint = Keypair.generate();
  const [extraMetas, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()], HOOK);
  const mintLen = getMintLen([ExtensionType.TransferHook]);
  send([
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: mintLen,
      lamports: Number(svm.minimumBalanceForRentExemption(BigInt(mintLen))), programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferHookInstruction(mint.publicKey, payer.publicKey, HOOK, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, 9, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
  ], [mint]);
  send([{ programId: HOOK, keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: extraMetas, isSigner: false, isWritable: true },
    { pubkey: mint.publicKey, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
    data: createHash("sha256").update("global:initialize_extra_account_meta_list").digest().subarray(0, 8),
  } as TransactionInstruction], []);

  const src = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const dstOwner = Keypair.generate();
  const dst = getAssociatedTokenAddressSync(mint.publicKey, dstOwner.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  send([
    createAssociatedTokenAccountInstruction(payer.publicKey, src, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(payer.publicKey, dst, dstOwner.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, src, payer.publicKey, 10n ** 15n, [], TOKEN_2022_PROGRAM_ID),
  ], []);

  const ix = createTransferCheckedInstruction(src, mint.publicKey, dst, payer.publicKey, 1000n, 9, [], TOKEN_2022_PROGRAM_ID);
  ix.keys.push({ pubkey: HOOK, isSigner: false, isWritable: false });
  ix.keys.push({ pubkey: extraMetas, isSigner: false, isWritable: false });
  const r = send([ix], []);
  if (r instanceof FailedTransactionMetadata) { console.log("transfer failed", r.err().toString()); continue; }
  samples.push({ bump, cu: Number((r as any).computeUnitsConsumed()) });
}

samples.sort((a, b) => b.bump - a.bump);
console.log("bump   iterations   transfer CU");
for (const s of samples) console.log(`${String(s.bump).padStart(4)}${String(255 - s.bump + 1).padStart(12)}${String(s.cu).padStart(14)}`);

const lo = samples[0], hi = samples[samples.length - 1];
console.log(`\nbump ${lo.bump} -> ${lo.cu} CU`);
console.log(`bump ${hi.bump} -> ${hi.cu} CU`);
console.log(`spread: ${hi.cu - lo.cu} CU across ${lo.bump - hi.bump} bump steps`);
const perStep = (hi.cu - lo.cu) / (lo.bump - hi.bump || 1);
console.log(`~${perStep.toFixed(0)} CU per extra bump iteration`);
