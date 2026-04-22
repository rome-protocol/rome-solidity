/**
 * Mock PriceUpdateV2 (Pyth Pull) account builder for testing PythPullParser.
 *
 * Layout (Borsh/Anchor, little-endian, Full verification variant):
 *   [0..8]     Anchor discriminator
 *   [8..40]    write_authority (Pubkey)
 *   [40]       verification_level = Full (0x01, 1 byte)
 *   [41..73]   feed_id ([u8;32])
 *   [73..81]   price (i64)
 *   [81..89]   conf (u64)
 *   [89..93]   exponent (i32)
 *   [93..101]  publish_time (i64)
 *   [101..109] prev_publish_time (i64)
 *   [109..117] ema_price (i64)
 *   [117..125] ema_conf (u64)
 *   [125..133] posted_slot (u64)
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
    /// Verification variant byte at offset 40. Pyth's Anchor enum uses
    /// 0x00 = Partial, 0x01 = Full. Defaults to Full. Set to 0x00 to exercise
    /// the parser's variant guard (M-1).
    verificationVariant?: number;
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
 * Build a mock PriceUpdateV2 account byte array (Full verification variant).
 * Returns a hex string prefixed with 0x, suitable for passing to Solidity.
 */
export function buildPythPullAccount(params: PythPullAccountParams): `0x${string}` {
    const buf = new Uint8Array(133);

    // Anchor discriminator at offset 0 (8 bytes, big-endian to match Solidity bytes8)
    const disc = params.discriminator ?? DEFAULT_DISCRIMINATOR;
    for (let i = 0; i < 8; i++) {
        buf[i] = Number((disc >> BigInt((7 - i) * 8)) & 0xffn);
    }

    // verification_level at offset 40 (default 0x01 = Full)
    buf[40] = params.verificationVariant ?? 0x01;

    // price at offset 73 (i64, LE)
    writeInt64LE(buf, 73, params.price);

    // conf at offset 81 (u64, LE)
    writeUint64LE(buf, 81, params.conf);

    // exponent at offset 89 (i32, LE)
    writeInt32LE(buf, 89, params.expo);

    // publish_time at offset 93 (i64, LE)
    writeInt64LE(buf, 93, BigInt(params.publishTime));

    // ema_price at offset 109 (i64, LE)
    writeInt64LE(buf, 109, params.emaPrice ?? 0n);

    // ema_conf at offset 117 (u64, LE)
    writeUint64LE(buf, 117, params.emaConf ?? 0n);

    const hex = Array.from(buf)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    return `0x${hex}`;
}
