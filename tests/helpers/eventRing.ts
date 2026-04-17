/**
 * eventRing.ts — TypeScript port of the byte layout + PDA seed helpers from
 * rome-solana/src/events/layout.rs (T15).
 *
 * Pure byte-layout helpers: no runtime Solana dependency in this module itself.
 * deriveEventRingPda() dynamically imports @solana/web3.js — call it only inside
 * integration-gated code paths (RUN_EVENT_PDA_INTEGRATION=1).
 */

export const RING_HEADER_SIZE = 36;
export const ENTRY_FIXED_SIZE = 205;
export const EVENT_RING_SEED = new TextEncoder().encode("event_log");

/**
 * Ring-buffer header — first 36 bytes of the PDA account.
 *
 * Layout (all LE):
 *   ver       u8       offset 0
 *   bump      u8       offset 1
 *   capacity  u32 LE   offset 2
 *   data_cap  u16 LE   offset 6
 *   head      u32 LE   offset 8
 *   count     u64 LE   offset 12
 *   init_slot u64 LE   offset 20
 *   _reserved [u8;8]   offset 28  (8 bytes, total = 36)
 */
export interface EventRingHeader {
  ver: number;
  bump: number;
  capacity: number;
  dataCap: number;
  head: number;
  count: bigint;
  initSlot: bigint;
}

/**
 * A single persisted event entry, decoded from the ring buffer.
 *
 * Entry prefix (205 bytes fixed):
 *   seq         u64 LE   offset 0
 *   slot        u64 LE   offset 8
 *   tx_hash     [32]     offset 16
 *   emitter     [20]     offset 48
 *   topic_count u8       offset 68
 *   topics      [[32];4] offset 69  (128 bytes, 4 × 32)
 *   data_len    u16 LE   offset 197
 *   truncated   u8       offset 199
 *   _pad        [5]      offset 200  (5 bytes, total = 205)
 *
 * Entry trailing: data [data_cap bytes]
 * Entry stride = 205 + data_cap
 */
export interface PersistedEvent {
  seq: bigint;
  slot: bigint;
  txHash: Uint8Array;    // 32 bytes
  emitter: Uint8Array;   // 20 bytes
  topics: Uint8Array[];  // 1..=4 × 32 bytes each
  data: Uint8Array;
  truncated: boolean;
}

export function entryStride(dataCap: number): number {
  return ENTRY_FIXED_SIZE + dataCap;
}

export function readU16LE(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}

export function readU32LE(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

export function readU64LE(b: Uint8Array, off: number): bigint {
  let r = 0n;
  for (let i = 0; i < 8; i++) r |= BigInt(b[off + i]) << BigInt(8 * i);
  return r;
}

export function writeU64LE(out: Uint8Array, off: number, v: bigint): void {
  for (let i = 0; i < 8; i++) out[off + i] = Number((v >> BigInt(8 * i)) & 0xffn);
}

export function parseRingHeader(data: Uint8Array): EventRingHeader | null {
  if (data.length < RING_HEADER_SIZE) return null;
  return {
    ver:      data[0],
    bump:     data[1],
    capacity: readU32LE(data, 2),
    dataCap:  readU16LE(data, 6),
    head:     readU32LE(data, 8),
    count:    readU64LE(data, 12),
    initSlot: readU64LE(data, 20),
  };
}

export function parseEntry(
  data: Uint8Array,
  hdr: EventRingHeader,
  idx: number,
): PersistedEvent | null {
  if (idx >= hdr.capacity) return null;
  const stride = entryStride(hdr.dataCap);
  const off = RING_HEADER_SIZE + idx * stride;
  if (data.length < off + stride) return null;
  const e = data.subarray(off, off + stride);

  const seq = readU64LE(e, 0);
  const slot = readU64LE(e, 8);
  const txHash = e.subarray(16, 48);
  const emitter = e.subarray(48, 68);
  const topicCount = e[68];
  if (topicCount > 4) return null;
  const topics: Uint8Array[] = [];
  for (let i = 0; i < topicCount; i++) {
    const o = 69 + i * 32;
    topics.push(new Uint8Array(e.subarray(o, o + 32)));
  }
  // data_len at fixed offset 197 (= 69 + 4*32)
  const dataLenOff = 197;
  const dataLen = readU16LE(e, dataLenOff);
  const truncated = e[dataLenOff + 2] !== 0;
  // data starts at offset 205 (= 197 + 2 + 1 + 5)
  const dataOff = 205;
  const dataBytes = e.subarray(dataOff, dataOff + dataLen);

  return {
    seq,
    slot,
    txHash: new Uint8Array(txHash),
    emitter: new Uint8Array(emitter),
    topics,
    data: new Uint8Array(dataBytes),
    truncated,
  };
}

/**
 * Derives the event-ring PDA for a given emitter address.
 *
 * Seed: [chain_id u64 LE (8 bytes) | "event_log" (9 bytes) | emitter_addr (20 bytes)]
 *
 * NOTE: Dynamically imports @solana/web3.js at call time. Only call this inside
 * integration-gated paths (RUN_EVENT_PDA_INTEGRATION=1). The package is not listed
 * in package.json — the dynamic import will throw if it is absent, which is the
 * intended behaviour (tests skip before reaching this path).
 *
 * @param programId  base58 pubkey string of the rome-evm program
 * @param chainId    chain id as bigint
 * @param emitterHex 0x-prefixed 20-byte hex EVM address
 */
export async function deriveEventRingPda(
  programId: string,
  chainId: bigint,
  emitterHex: string,
): Promise<{ pubkey: string; bump: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { PublicKey } = await import("@solana/web3.js") as any;
  const emitterBytes = hexToBytes(emitterHex);
  const chainIdBytes = new Uint8Array(8);
  writeU64LE(chainIdBytes, 0, chainId);
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [chainIdBytes, EVENT_RING_SEED, emitterBytes],
    new PublicKey(programId),
  );
  return { pubkey: pda.toBase58(), bump };
}

/**
 * Converts a 0x-prefixed 20-byte hex string to a Uint8Array.
 */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length !== 40) throw new Error(`expected 20-byte hex address, got ${h.length / 2} bytes`);
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
