/**
 * Mock PriceUpdateV2 (Pyth Pull) account builder for testing PythPullParser.
 *
 * Layout (Borsh/Anchor, little-endian):
 *   [0..8]     Anchor discriminator
 *   [8..40]    write_authority (Pubkey)
 *   [40..42]   verification_level (enum: 1 byte tag + 1 byte num_signatures)
 *   [42..74]   feed_id ([u8;32])
 *   [74..82]   price (i64)
 *   [82..90]   conf (u64)
 *   [90..94]   exponent (i32)
 *   [94..102]  publish_time (i64)
 *   [102..110] prev_publish_time (i64)
 *   [110..118] ema_price (i64)
 *   [118..126] ema_conf (u64)
 *   [126..134] posted_slot (u64)
 */

export interface PythPullAccountParams {
    discriminator?: bigint;
    price: bigint;
    conf: bigint;
    expo: number;
    publishTime: number;
    emaPrice?: bigint;
    emaConf?: bigint;
    feedId?: string;
}

const DEFAULT_DISCRIMINATOR = 0x22f123639d7ef4cdn;

function writeBytes8LE(buf: Uint8Array, offset: number, value: bigint): void {
    const unsigned = value < 0n ? value + (1n << 64n) : value;
    for (let i = 0; i < 8; i++) {
        buf[offset + i] = Number((unsigned >> BigInt(i * 8)) & 0xffn);
    }
}

function writeInt32LE(buf: Uint8Array, offset: number, value: number): void {
    const unsigned = value < 0 ? value + 0x100000000 : value;
    buf[offset] = unsigned & 0xff;
    buf[offset + 1] = (unsigned >>> 8) & 0xff;
    buf[offset + 2] = (unsigned >>> 16) & 0xff;
    buf[offset + 3] = (unsigned >>> 24) & 0xff;
}

function writeInt64LE(buf: Uint8Array, offset: number, value: bigint): void {
    writeBytes8LE(buf, offset, value);
}

function writeUint64LE(buf: Uint8Array, offset: number, value: bigint): void {
    writeBytes8LE(buf, offset, value);
}

/**
 * Build a mock PriceUpdateV2 account byte array.
 * Returns a hex string prefixed with 0x, suitable for passing to Solidity.
 */
export function buildPythPullAccount(params: PythPullAccountParams): `0x${string}` {
    const buf = new Uint8Array(134);

    // Anchor discriminator at offset 0 (8 bytes, big-endian to match Solidity bytes8)
    const disc = params.discriminator ?? DEFAULT_DISCRIMINATOR;
    for (let i = 0; i < 8; i++) {
        buf[i] = Number((disc >> BigInt((7 - i) * 8)) & 0xffn);
    }

    // price at offset 74 (i64, LE)
    writeInt64LE(buf, 74, params.price);

    // conf at offset 82 (u64, LE)
    writeUint64LE(buf, 82, params.conf);

    // exponent at offset 90 (i32, LE)
    writeInt32LE(buf, 90, params.expo);

    // publish_time at offset 94 (i64, LE)
    writeInt64LE(buf, 94, BigInt(params.publishTime));

    // ema_price at offset 110 (i64, LE)
    writeInt64LE(buf, 110, params.emaPrice ?? 0n);

    // ema_conf at offset 118 (u64, LE)
    writeUint64LE(buf, 118, params.emaConf ?? 0n);

    const hex = Array.from(buf)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return `0x${hex}`;
}
