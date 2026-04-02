/**
 * Mock Switchboard V2 AggregatorAccountData builder for testing SwitchboardParser.
 *
 * Validated layout (from live SOL/USD aggregator on monti_spl):
 *   [0..8]     Anchor discriminator (0xd9e64165c9a21b7d)
 *   [8..40]    name
 *   ...        (many config fields)
 *   [350..358] round_open_slot (u64, LE)
 *   [358..366] round_open_timestamp (i64, LE)
 *   [366..382] result.mantissa (i128, LE)
 *   [382..386] result.scale (u32, LE)
 *
 * Total minimum: 386 bytes
 */

export interface SwitchboardAccountParams {
    discriminator?: bigint;
    mantissa: bigint;
    scale: number;
    slot?: bigint;
    timestamp: number;
}

const DEFAULT_DISCRIMINATOR = 0xd9e64165c9a21b7dn;

function writeBytes8BE(buf: Uint8Array, offset: number, value: bigint): void {
    for (let i = 0; i < 8; i++) {
        buf[offset + i] = Number((value >> BigInt((7 - i) * 8)) & 0xffn);
    }
}

function writeInt128LE(buf: Uint8Array, offset: number, value: bigint): void {
    const unsigned = value < 0n ? value + (1n << 128n) : value;
    for (let i = 0; i < 16; i++) {
        buf[offset + i] = Number((unsigned >> BigInt(i * 8)) & 0xffn);
    }
}

function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
    buf[offset] = value & 0xff;
    buf[offset + 1] = (value >>> 8) & 0xff;
    buf[offset + 2] = (value >>> 16) & 0xff;
    buf[offset + 3] = (value >>> 24) & 0xff;
}

function writeUint64LE(buf: Uint8Array, offset: number, value: bigint): void {
    for (let i = 0; i < 8; i++) {
        buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
    }
}

function writeInt64LE(buf: Uint8Array, offset: number, value: bigint): void {
    const unsigned = value < 0n ? value + (1n << 64n) : value;
    writeUint64LE(buf, offset, unsigned);
}

/**
 * Build a mock Switchboard V2 AggregatorAccountData byte array.
 * Returns a hex string prefixed with 0x, suitable for passing to Solidity.
 */
export function buildSwitchboardAccount(params: SwitchboardAccountParams): `0x${string}` {
    const buf = new Uint8Array(386);

    // Anchor discriminator at offset 0 (8 bytes, big-endian to match Solidity bytes8)
    const disc = params.discriminator ?? DEFAULT_DISCRIMINATOR;
    writeBytes8BE(buf, 0, disc);

    // round_open_slot at offset 350 (u64, LE)
    writeUint64LE(buf, 350, params.slot ?? 0n);

    // round_open_timestamp at offset 358 (i64, LE)
    writeInt64LE(buf, 358, BigInt(params.timestamp));

    // result.mantissa at offset 366 (i128, LE)
    writeInt128LE(buf, 366, params.mantissa);

    // result.scale at offset 382 (u32, LE)
    writeUint32LE(buf, 382, params.scale);

    const hex = Array.from(buf)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return `0x${hex}`;
}
