/**
 * Mock Pyth V2 PriceAccount builder for testing PythParser.
 *
 * Constructs byte arrays matching the Pyth V2 PriceAccount layout:
 *   [0..4]     magic (0xa1b2c3d4, LE)
 *   [4..8]     version (2, LE)
 *   [20..24]   exponent (int32, LE)
 *   [208..216] aggregate price (int64, LE)
 *   [216..224] aggregate confidence (uint64, LE)
 *   [232..240] publish_time (int64, LE)
 */

export interface PythV2AccountParams {
    magic?: number;
    version?: number;
    price: bigint;
    conf: bigint;
    expo: number;
    publishTime: number;
}

function writeUint32LE(buf: Uint8Array, offset: number, value: number): void {
    buf[offset] = value & 0xff;
    buf[offset + 1] = (value >>> 8) & 0xff;
    buf[offset + 2] = (value >>> 16) & 0xff;
    buf[offset + 3] = (value >>> 24) & 0xff;
}

function writeInt32LE(buf: Uint8Array, offset: number, value: number): void {
    // Convert signed to unsigned 32-bit representation
    writeUint32LE(buf, offset, value < 0 ? value + 0x100000000 : value);
}

function writeInt64LE(buf: Uint8Array, offset: number, value: bigint): void {
    // Convert signed to unsigned 64-bit representation
    const unsigned = value < 0n ? value + (1n << 64n) : value;
    for (let i = 0; i < 8; i++) {
        buf[offset + i] = Number((unsigned >> BigInt(i * 8)) & 0xffn);
    }
}

function writeUint64LE(buf: Uint8Array, offset: number, value: bigint): void {
    for (let i = 0; i < 8; i++) {
        buf[offset + i] = Number((value >> BigInt(i * 8)) & 0xffn);
    }
}

/**
 * Build a mock Pyth V2 PriceAccount byte array.
 * Returns a hex string prefixed with 0x, suitable for passing to Solidity.
 */
export function buildPythV2Account(params: PythV2AccountParams): `0x${string}` {
    const buf = new Uint8Array(240); // Minimum size for V2

    // Magic at offset 0
    writeUint32LE(buf, 0, params.magic ?? 0xa1b2c3d4);

    // Version at offset 4
    writeUint32LE(buf, 4, params.version ?? 2);

    // Exponent at offset 20 (int32)
    writeInt32LE(buf, 20, params.expo);

    // Aggregate price at offset 208 (int64)
    writeInt64LE(buf, 208, params.price);

    // Aggregate confidence at offset 216 (uint64)
    writeUint64LE(buf, 216, params.conf);

    // Publish time at offset 232 (int64)
    writeInt64LE(buf, 232, BigInt(params.publishTime));

    // Convert to hex string
    const hex = Array.from(buf)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return `0x${hex}`;
}
