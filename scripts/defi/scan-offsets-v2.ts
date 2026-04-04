import { Connection, PublicKey } from "@solana/web3.js";

/**
 * V2 scanner: Uses non-zero market indices to pinpoint exact field offsets.
 * Also discovers Kamino reserve accounts dynamically.
 */

function readU8(d: Buffer, o: number): number { return d.readUInt8(o); }
function readU16LE(d: Buffer, o: number): number { return d.readUInt16LE(o); }
function readU32LE(d: Buffer, o: number): number { return d.readUInt32LE(o); }
function readU64LE(d: Buffer, o: number): bigint { return d.readBigUInt64LE(o); }
function readI64LE(d: Buffer, o: number): bigint { return d.readBigInt64LE(o); }
function readU128LE(d: Buffer, o: number): bigint {
    return (d.readBigUInt64LE(o + 8) << 64n) | d.readBigUInt64LE(o);
}
function readPubkey(d: Buffer, o: number): string {
    return new PublicKey(d.subarray(o, o + 32)).toBase58();
}
function findPubkey(data: Buffer, pubkey: PublicKey): number[] {
    const needle = pubkey.toBuffer();
    const offsets: number[] = [];
    for (let i = 0; i <= data.length - 32; i++) {
        if (data.subarray(i, i + 32).equals(needle)) offsets.push(i);
    }
    return offsets;
}

const DRIFT = new PublicKey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const KAMINO = new PublicKey("KLend2g3cP87ber8pxFQKRb4bV6YtYZge56YVJZsKpp");

async function main() {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    const conn = new Connection(rpcUrl, "confirmed");

    // ═══════════════════════════════
    //  DRIFT — Use market_index=1 (ETH-PERP) for unique offset search
    // ═══════════════════════════════

    // PerpMarket 1 (ETH-PERP)
    const perpPda1 = PublicKey.findProgramAddressSync(
        [Buffer.from("perp_market"), Buffer.from([1, 0])], DRIFT
    )[0];

    console.log("═══ DRIFT PERP MARKET 1 (ETH-PERP) ═══");
    console.log("PDA:", perpPda1.toBase58());
    const perpInfo1 = await conn.getAccountInfo(perpPda1);
    if (!perpInfo1) { console.error("Not found!"); return; }
    const pd = Buffer.from(perpInfo1.data);
    console.log("Size:", pd.length);

    // Find market_index=1 (u16le = 0x0100)
    console.log("\nSearching for u16le value 1 (market_index):");
    for (let o = 0; o < pd.length - 2; o++) {
        if (pd.readUInt16LE(o) === 1) {
            // Filter: must be at a reasonable position (after AMM struct, so >800)
            if (o > 800) {
                const prevU32 = o >= 4 ? pd.readUInt32LE(o - 4) : 0;
                const nextU8 = readU8(pd, o + 2);
                console.log(`  [${o}] market_index=1, prev_u32=${prevU32}, next_u8=${nextU8} (status?)`);
            }
        }
    }

    // SpotMarket 1 (SOL)
    const spotPda1 = PublicKey.findProgramAddressSync(
        [Buffer.from("spot_market"), Buffer.from([1, 0])], DRIFT
    )[0];

    console.log("\n═══ DRIFT SPOT MARKET 1 (SOL) ═══");
    console.log("PDA:", spotPda1.toBase58());
    const spotInfo1 = await conn.getAccountInfo(spotPda1);
    if (!spotInfo1) { console.error("Not found!"); return; }
    const sd = Buffer.from(spotInfo1.data);
    console.log("Size:", sd.length);

    // Find market_index=1 (u16le)
    console.log("\nSearching for u16le value 1 (market_index):");
    for (let o = 200; o < sd.length - 2; o++) {
        if (sd.readUInt16LE(o) === 1) {
            const nextU8 = readU8(sd, o + 2);
            // status should be small (0-5), and decimals=9 for SOL should be nearby
            if (nextU8 <= 5) {
                // Check for decimals=9 within next few bytes
                for (let d = 3; d <= 8; d++) {
                    if (o + d < sd.length && readU8(sd, o + d) === 9) {
                        console.log(`  [${o}] market_index=1, [${o+2}] status=${nextU8}, [${o+d}] decimals=9`);
                    }
                }
            }
        }
    }

    // Also scan SOL SpotMarket for sequential pubkey fields
    console.log("\nSpotMarket 1 pubkeys:");
    console.log(`  [8]  self:   ${readPubkey(sd, 8)}`);
    console.log(`  [40] oracle: ${readPubkey(sd, 40)}`);
    console.log(`  [72] mint:   ${readPubkey(sd, 72)}`);
    console.log(`  [104] vault: ${readPubkey(sd, 104)}`);
    console.log(`  [136] name:  ${sd.subarray(136, 168).toString("utf8").replace(/\0/g, "")}`);

    // Now let's check spot market 0 with corrected pubkey offset (+32)
    const spotPda0 = PublicKey.findProgramAddressSync(
        [Buffer.from("spot_market"), Buffer.from([0, 0])], DRIFT
    )[0];
    const spotInfo0 = await conn.getAccountInfo(spotPda0);
    if (spotInfo0) {
        const s0d = Buffer.from(spotInfo0.data);
        console.log("\n═══ DRIFT SPOT MARKET 0 (USDC) — corrected ═══");
        console.log(`  [8]  pubkey: ${readPubkey(s0d, 8)}`);
        console.log(`  [40] oracle: ${readPubkey(s0d, 40)}`);
        console.log(`  [72] mint:   ${readPubkey(s0d, 72)} ${readPubkey(s0d, 72) === USDC_MINT.toBase58() ? "✓ USDC" : ""}`);
        console.log(`  [104] vault: ${readPubkey(s0d, 104)}`);
        console.log(`  [136] name:  ${s0d.subarray(136, 168).toString("utf8").replace(/\0/g, "")}`);
    }

    // PerpMarket 0 with corrected oracle offset (+32 for pubkey)
    const perpPda0 = PublicKey.findProgramAddressSync(
        [Buffer.from("perp_market"), Buffer.from([0, 0])], DRIFT
    )[0];
    const perpInfo0 = await conn.getAccountInfo(perpPda0);
    if (perpInfo0) {
        const p0d = Buffer.from(perpInfo0.data);
        console.log("\n═══ DRIFT PERP MARKET 0 (SOL-PERP) — corrected offsets ═══");
        console.log(`  [8]  pubkey (self): ${readPubkey(p0d, 8)}`);
        console.log(`  [40] amm.oracle:    ${readPubkey(p0d, 40)}`);

        // With +32 shift: base_asset_reserve was at 328, now try 360
        const bar328 = readU128LE(p0d, 328);
        const bar360 = readU128LE(p0d, 360);
        console.log(`  [328] u128: ${bar328}`);
        console.log(`  [360] u128: ${bar360}`);

        // Scan for timestamps in the AMM area with +32 shift
        console.log("\n  Timestamps (plausible i64 values):");
        for (let o = 40; o <= p0d.length - 8; o += 8) {
            const v = Number(readI64LE(p0d, o));
            if (v > 1_700_000_000 && v < 1_900_000_000) {
                console.log(`    [${o}] ${v} → ${new Date(v * 1000).toISOString()}`);
            }
        }
    }

    // ═══════════════════════════════
    //  KAMINO — Try finding reserves with different sizes
    // ═══════════════════════════════

    console.log("\n\n═══ KAMINO LENDING — DISCOVERY ═══");
    console.log("Program:", KAMINO.toBase58());

    // Try common reserve sizes
    for (const size of [8616, 8600, 8624, 8632, 8640, 8728, 8856, 8984]) {
        try {
            const accts = await conn.getProgramAccounts(KAMINO, {
                dataSlice: { offset: 0, length: 0 },
                filters: [{ dataSize: size }],
            });
            if (accts.length > 0) {
                console.log(`\n  Size ${size}: found ${accts.length} accounts!`);
                // Fetch the first one
                const first = accts[0].pubkey;
                console.log(`  First account: ${first.toBase58()}`);
                const info = await conn.getAccountInfo(first);
                if (info) {
                    const rd = Buffer.from(info.data);
                    console.log(`  discriminator: ${rd.subarray(0, 8).toString("hex")}`);

                    // Check if USDC mint is in this data
                    const usdcLocs = findPubkey(rd, USDC_MINT);
                    if (usdcLocs.length > 0) {
                        console.log(`  USDC mint found at offsets: ${usdcLocs.join(", ")}`);
                    }

                    // Parse header
                    let o = 8;
                    const version = readU64LE(rd, o); o += 8;
                    const slot = readU64LE(rd, o); o += 8;
                    const stale = readU8(rd, o); o += 1;
                    console.log(`  version=${version}, slot=${slot}, stale=${stale}`);

                    const lendingMarket = readPubkey(rd, o);
                    console.log(`  [${o}] lending_market: ${lendingMarket}`);
                    o += 32;

                    const liqMint = readPubkey(rd, o);
                    console.log(`  [${o}] liquidity_mint: ${liqMint}`);
                    o += 32;

                    const liqSupply = readPubkey(rd, o);
                    console.log(`  [${o}] liquidity_supply_vault: ${liqSupply}`);
                    o += 32;

                    const feeVault = readPubkey(rd, o);
                    console.log(`  [${o}] fee_vault: ${feeVault}`);
                    o += 32;

                    const oracle = readPubkey(rd, o);
                    console.log(`  [${o}] liquidity_oracle: ${oracle}`);
                    o += 32;

                    const avail = readU64LE(rd, o);
                    console.log(`  [${o}] available_amount: ${avail}`);
                    o += 8;

                    const borrowed = readU128LE(rd, o);
                    console.log(`  [${o}] borrowed_amount_sf: ${borrowed}`);
                    o += 16;

                    const cumRate = readU128LE(rd, o);
                    console.log(`  [${o}] cumulative_borrow_rate_sf: ${cumRate}`);
                    o += 16;

                    console.log(`  Current offset: ${o}`);

                    // Search for config bytes (LTV) around offset 600-900
                    console.log(`\n  Config bytes search (LTV 50-95):`);
                    for (let co = 500; co < Math.min(900, rd.length); co++) {
                        const v = readU8(rd, co);
                        if (v >= 50 && v <= 95) {
                            const next = readU8(rd, co + 1);
                            if (next >= 50 && next <= 100) {
                                console.log(`    [${co}] ${v}, [${co+1}] ${next} — possible LTV/liq_threshold pair`);
                            }
                        }
                    }
                }
                break;
            }
        } catch {
            // Rate limited or no results, try next
        }
    }
}

main().catch(console.error);
