/** Building blocks for the schedule hook: PDAs, instruction encoding, accounts. */
import { PublicKey, SystemProgram, TransactionInstruction, AccountMeta } from "@solana/web3.js";
import { createHash } from "crypto";
import type { Market } from "./presets";

export const HOOK_PROGRAM_ID = new PublicKey("CUvtmRQZ6zikB7VijWzqS78orxrrkQhYkbhDL4PaPD6k");

export const scheduleAddress = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("schedule"), mint.toBuffer()], HOOK_PROGRAM_ID)[0];

export const registryAddress = () =>
  PublicKey.findProgramAddressSync([Buffer.from("registry")], HOOK_PROGRAM_ID)[0];

/** A market is approved by the existence of the PDA for its schedule hash. */
export const marketAddress = (scheduleHash: Buffer) =>
  PublicKey.findProgramAddressSync([Buffer.from("market"), scheduleHash], HOOK_PROGRAM_ID)[0];

export const scheduleHash = (m: Market) =>
  createHash("sha256").update(encodeScheduleForHash(m)).digest();

export const extraAccountMetasAddress = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    HOOK_PROGRAM_ID
  )[0];

const discriminator = (name: string) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/**
 * Borsh encoding of ScheduleArgs. Exported because the program identifies an
 * approved market by the sha256 of exactly these bytes, so the launcher and
 * `npm run hash:markets` must agree byte for byte.
 */
export function encodeScheduleForHash(m: Market): Buffer {
  const parts: Buffer[] = [];
  const i16 = (v: number) => { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; };
  const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const i32 = (v: number) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };

  parts.push(i16(m.tzOffsetMinutes));
  parts.push(Buffer.from([m.dstRule]));
  parts.push(i32(m.baseDay));

  parts.push(u32(m.windows.length));
  for (const w of m.windows) parts.push(Buffer.from([w.daysMask]), u16(w.openMinute), u16(w.closeMinute));

  const holidays = [...m.holidays].sort((a, b) => a - b);
  parts.push(u32(holidays.length));
  for (const h of holidays) parts.push(u16(h));

  parts.push(u32(m.earlyCloses.length));
  for (const e of m.earlyCloses) parts.push(u16(e.dayOffset), u16(e.closeMinute));

  const i64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
  parts.push(u32(m.events.length));
  for (const e of m.events) parts.push(i64(e.start), i64(e.end), Buffer.from([e.allow ? 1 : 0]));

  return Buffer.concat(parts);
}

/**
 * Write the mint's schedule and the hook's validation state.
 *
 * Must run before anyone can transfer the mint: without the validation state
 * Token-2022 cannot resolve the hook's extra accounts and every transfer
 * fails. The schedule is written once and there is no instruction to change
 * it, so the market a token launches with is the market it keeps.
 */
export function initializeScheduleIx(
  mint: PublicKey,
  payer: PublicKey,
  market: Market,
  /** Pass true for a market approved via the registry rather than compiled in. */
  viaRegistry = false
): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: scheduleAddress(mint), isSigner: false, isWritable: true },
    { pubkey: extraAccountMetasAddress(mint), isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
  ];
  // Anchor signals an absent optional account by passing the program id in
  // its slot, so the slot is always present.
  keys.push({
    pubkey: viaRegistry ? marketAddress(scheduleHash(market)) : HOOK_PROGRAM_ID,
    isSigner: false,
    isWritable: false,
  });
  keys.push({ pubkey: SystemProgram.programId, isSigner: false, isWritable: false });
  return new TransactionInstruction({
    programId: HOOK_PROGRAM_ID,
    keys,
    data: Buffer.concat([discriminator("initialize"), encodeScheduleForHash(market)]),
  });
}

/** Create the market registry. Only REGISTRY_BOOTSTRAP may send this. */
export function initializeRegistryIx(payer: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: HOOK_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: registryAddress(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator("initialize_registry"), authority.toBuffer()]),
  });
}

/** Approve a market, so future tokens may launch with it. */
export function registerMarketIx(
  payer: PublicKey,
  authority: PublicKey,
  m: Market
): TransactionInstruction {
  const hash = scheduleHash(m);
  return new TransactionInstruction({
    programId: HOOK_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: registryAddress(), isSigner: false, isWritable: false },
      { pubkey: marketAddress(hash), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator("register_market"), hash]),
  });
}

/**
 * The accounts Token-2022 appends to a TransferChecked for this hook: the
 * resolved extras first, then the hook program, then the validation state.
 */
export function transferHookAccounts(mint: PublicKey): AccountMeta[] {
  return [
    { pubkey: scheduleAddress(mint), isSigner: false, isWritable: false },
    { pubkey: HOOK_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: extraAccountMetasAddress(mint), isSigner: false, isWritable: false },
  ];
}
