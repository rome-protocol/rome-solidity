import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Scans raw Solana account data to locate known field values and
 * determine correct byte offsets for our Solidity parsers.
 */

function readU8(d: Buffer, o: number): number { return d.readUInt8(o); }
function readU16LE(d: Buffer, o: number): number { return d.readUInt16LE(o); }
function readU64LE(d: Buffer, o: number): bigint { return d.readBigUInt64LE(o); }
function readI64LE(d: Buffer, o: number): bigint { return d.readBigInt64LE(o); }
function readU128LE(d: Buffer, o: number): bigint {
    return (d.readBigUInt64LE(o + 8) << 64n) | d.readBigUInt64LE(o);
}
function readPubkey(d: Buffer, o: number): string {
    return new PublicKey(d.subarray(o, o + 32)).toBase58();
}

/** Search for a 32-byte pubkey in account data, return all offsets */
function findPubkey(data: Buffer, pubkey: PublicKey): number[] {
    const needle = pubkey.toBuffer();
    const offsets: number[] = [];
    for (let i = 0; i <= data.length - 32; i++) {
        if (data.subarray(i, i + 32).equals(needle)) {
            offsets.push(i);
        }
    }
    return offsets;
}

/** Find all offsets where a u16le value appears */
function findU16(data: Buffer, value: number): number[] {
    const offsets: number[] = [];
    for (let i = 0; i <= data.length - 2; i++) {
        if (data.readUInt16LE(i) === value) offsets.push(i);
    }
    return offsets;
}

/** Find all offsets where a u8 value appears */
function findU8After(data: Buffer, value: number, after: number): number[] {
    const offsets: number[] = [];
    for (let i = after; i < data.length; i++) {
        if (data.readUInt8(i) === value) offsets.push(i);
    }
    return offsets;
}

// ── Known IDs ─────────────────────────────

const DRIFT_PROGRAM_ID = new PublicKey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const KAMINO_LENDING_PROGRAM_ID = new PublicKey("KLend2g3cP87ber8pxFQKRb4bV6YtYZge56YVJZsKpp");

async function main() {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");

    // ══════════════════════════════════════
    //  DRIFT PERP MARKET 0 (SOL-PERP)
    // ══════════════════════════════════════

    const perpMarketPda = PublicKey.findProgramAddressSync(
        [Buffer.from("perp_market"), Buffer.from([0, 0])],
        DRIFT_PROGRAM_ID
    )[0];

    console.log("═══ DRIFT PERP MARKET 0 ═══");
    console.log("PDA:", perpMarketPda.toBase58());
    const perpInfo = await connection.getAccountInfo(perpMarketPda);
    if (!perpInfo) { console.error("Not found"); return; }
    const pd = Buffer.from(perpInfo.data);
    console.log("Size:", pd.length, "bytes\n");

    // Discriminator
    console.log("discriminator:", pd.subarray(0, 8).toString("hex"));

    // The Drift PerpMarket struct starts with a `pubkey` field (self-reference)
    const selfRef = readPubkey(pd, 8);
    console.log("[8] pubkey (self):", selfRef, selfRef === perpMarketPda.toBase58() ? "✓ MATCH" : "✗");

    // After pubkey (8+32=40), the AMM substruct starts
    console.log("\n--- Scanning AMM fields after offset 40 ---");

    // AMM struct: first field is oracle (Pubkey)
    // Let's see what pubkeys are around offset 40-200
    for (let o = 40; o <= 200; o += 32) {
        const pk = readPubkey(pd, o);
        console.log(`  [${o}] pubkey: ${pk}`);
    }

    // Search for market_index = 0 (u16) in likely ranges (near end of struct)
    console.log("\n--- Searching for market_index=0 (u16) near struct tail ---");
    // market_index is near the end of the PerpMarket struct, after the AMM
    // AMM is large (~600+ bytes). Let's search from offset 900+
    for (let o = 900; o < pd.length - 2; o++) {
        const v = readU16LE(pd, o);
        if (v === 0) {
            // Check if next byte is a small enum (status)
            const nextByte = readU8(pd, o + 2);
            if (nextByte <= 5) {
                console.log(`  Candidate: [${o}] market_index=0, [${o+2}] status=${nextByte}`);
            }
        }
    }

    // Find timestamps (i64 values between 2020 and 2030)
    console.log("\n--- Scanning for plausible timestamps ---");
    for (let o = 0; o <= pd.length - 8; o += 8) {
        const v = Number(readI64LE(pd, o));
        if (v > 1_577_836_800 && v < 1_893_456_000) { // 2020 to 2030
            console.log(`  [${o}] timestamp: ${v} (${new Date(v * 1000).toISOString()})`);
        }
    }

    // ══════════════════════════════════════
    //  DRIFT SPOT MARKET 0 (USDC)
    // ══════════════════════════════════════

    const spotMarketPda = PublicKey.findProgramAddressSync(
        [Buffer.from("spot_market"), Buffer.from([0, 0])],
        DRIFT_PROGRAM_ID
    )[0];

    console.log("\n\n═══ DRIFT SPOT MARKET 0 (USDC) ═══");
    console.log("PDA:", spotMarketPda.toBase58());
    const spotInfo = await connection.getAccountInfo(spotMarketPda);
    if (!spotInfo) { console.error("Not found"); return; }
    const sd = Buffer.from(spotInfo.data);
    console.log("Size:", sd.length, "bytes\n");

    console.log("discriminator:", sd.subarray(0, 8).toString("hex"));

    // Find USDC mint location
    const usdcOffsets = findPubkey(sd, USDC_MINT);
    console.log("USDC mint found at offsets:", usdcOffsets);

    // Find self-reference
    const selfOffsets = findPubkey(sd, spotMarketPda);
    console.log("Self pubkey found at offsets:", selfOffsets);

    // Scan pubkeys from offset 8
    console.log("\n--- Sequential pubkeys from offset 8 ---");
    for (let o = 8; o <= 200; o += 32) {
        const pk = readPubkey(sd, o);
        const labels: string[] = [];
        if (pk === spotMarketPda.toBase58()) labels.push("SELF");
        if (pk === USDC_MINT.toBase58()) labels.push("USDC_MINT");
        console.log(`  [${o}] ${pk} ${labels.join(" ")}`);
    }

    // Find decimals=6
    console.log("\n--- Searching for decimals=6 near end of struct ---");
    // market_index and decimals are typically near the end of the struct
    for (let o = 250; o < sd.length; o++) {
        const u16 = o <= sd.length - 2 ? readU16LE(sd, o) : -1;
        if (u16 === 0) {
            // Check a few bytes later for decimals=6
            for (let d = 1; d <= 6; d++) {
                if (o + 2 + d < sd.length && readU8(sd, o + 2 + d) === 6) {
                    const status = readU8(sd, o + 2);
                    if (status <= 5) {
                        console.log(`  Candidate: [${o}] market_index=0, [${o+2}] status=${status}, [${o+2+d}] decimals=6`);
                    }
                }
            }
        }
    }

    // ══════════════════════════════════════
    //  KAMINO LENDING — find a valid reserve
    // ══════════════════════════════════════

    console.log("\n\n═══ KAMINO LENDING — RESERVE SCAN ═══");

    // Known Kamino main market
    const MAIN_MARKET = new PublicKey("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");

    // Try to find reserves by scanning program accounts
    // First, try some well-known Kamino reserve accounts
    const knownReserves = [
        { name: "USDC", key: "d4A2prbA2nCUQC5Af1VbJFQEsCDv2UNzq6suRCyBifX" },
        { name: "SOL", key: "d4A2prbA2nCUQC5Af1VbJFQEsCDv2UNzq6suRCyBifX" },
        // Alternative USDC reserve addresses from Kamino
        { name: "USDC-alt1", key: "D6q6wuQSrifJKDDErMjaS5L7jzMNj9SMVhtLLENBJ6yQ" },
        { name: "SOL-main", key: "d4A2prbA2nCUQC5Af1VbJFQEsCDv2UNzq6suRCyBifX" },
    ];

    for (const reserve of knownReserves) {
        try {
            const pk = new PublicKey(reserve.key);
            console.log(`\nTrying ${reserve.name}: ${reserve.key}`);
            const info = await connection.getAccountInfo(pk);
            if (!info) {
                console.log("  Not found");
                continue;
            }
            console.log("  Owner:", info.owner.toBase58());
            console.log("  Size:", info.data.length, "bytes");

            if (info.owner.toBase58() !== KAMINO_LENDING_PROGRAM_ID.toBase58()) {
                console.log("  Not owned by Kamino Lending, skipping");
                continue;
            }

            const rd = Buffer.from(info.data);
            console.log("  discriminator:", rd.subarray(0, 8).toString("hex"));

            // Parse the header: disc(8) + version?(8) + last_update?(9) + lending_market(32)
            let offset = 8;
            // Try: version (u64)
            const version = readU64LE(rd, offset);
            console.log(`  [${offset}] version: ${version}`);
            offset += 8;

            // last_update: slot(u64) + stale(u8) = 9 bytes
            const slot = readU64LE(rd, offset);
            console.log(`  [${offset}] last_update.slot: ${slot}`);
            offset += 9;

            // lending_market
            const lm = readPubkey(rd, offset);
            console.log(`  [${offset}] lending_market: ${lm} ${lm === MAIN_MARKET.toBase58() ? "✓ MATCH" : ""}`);
            offset += 32;

            // Next pubkeys
            for (let i = 0; i < 4; i++) {
                const pk2 = readPubkey(rd, offset);
                const isUsdc = findPubkey(Buffer.from(new PublicKey(pk2).toBuffer()), USDC_MINT).length > 0 ? " USDC_MINT" : "";
                console.log(`  [${offset}] pubkey ${i}: ${pk2}${isUsdc}`);
                offset += 32;
            }

            // Search for USDC mint in this account
            const usdcInReserve = findPubkey(rd, USDC_MINT);
            console.log(`  USDC mint found at offsets: ${usdcInReserve.length > 0 ? usdcInReserve.join(", ") : "NOT FOUND"}`);

            // Search for LTV values (u8 between 50-90) around offset 700
            console.log("\n  --- Scanning config fields around offset 700 ---");
            for (let o = 680; o < 730 && o < rd.length; o++) {
                const v = readU8(rd, o);
                if (v >= 50 && v <= 95) {
                    console.log(`    [${o}] u8=${v} (possible LTV or liquidation threshold)`);
                }
            }

            break; // Found a valid reserve
        } catch (e: any) {
            console.log(`  Error: ${e.message?.slice(0, 80)}`);
        }
    }

    // ══════════════════════════════════════
    //  KAMINO — use getProgramAccounts to find a real reserve
    // ══════════════════════════════════════

    console.log("\n\n═══ KAMINO — Finding reserves via getProgramAccounts ═══");
    console.log("Fetching first reserve account from Kamino Lending program...");

    try {
        const accounts = await connection.getProgramAccounts(KAMINO_LENDING_PROGRAM_ID, {
            dataSlice: { offset: 0, length: 0 }, // just get the keys
            filters: [{ dataSize: 8616 }], // Reserve accounts are 8616 bytes
        });

        console.log(`Found ${accounts.length} reserve-sized accounts`);
        if (accounts.length > 0) {
            const firstReserve = accounts[0].pubkey;
            console.log("Using:", firstReserve.toBase58());

            const rInfo = await connection.getAccountInfo(firstReserve);
            if (rInfo) {
                const rd = Buffer.from(rInfo.data);
                console.log("Size:", rd.length);
                console.log("discriminator:", rd.subarray(0, 8).toString("hex"));

                let offset = 8;
                const version = readU64LE(rd, offset); offset += 8;
                const slot = readU64LE(rd, offset); offset += 8;
                const stale = readU8(rd, offset); offset += 1;
                console.log(`version=${version}, last_update.slot=${slot}, stale=${stale}`);

                const lm = readPubkey(rd, offset); offset += 32;
                console.log(`[${offset - 32}] lending_market: ${lm}`);

                // Liquidity fields
                const mint2 = readPubkey(rd, offset); offset += 32;
                console.log(`[${offset - 32}] liquidity_mint: ${mint2}`);

                const supplyVault = readPubkey(rd, offset); offset += 32;
                console.log(`[${offset - 32}] liquidity_supply_vault: ${supplyVault}`);

                const feeVault = readPubkey(rd, offset); offset += 32;
                console.log(`[${offset - 32}] fee_vault (skipped): ${feeVault}`);

                const oracle = readPubkey(rd, offset); offset += 32;
                console.log(`[${offset - 32}] liquidity_oracle: ${oracle}`);

                const availableAmt = readU64LE(rd, offset); offset += 8;
                console.log(`[${offset - 8}] available_amount: ${availableAmt}`);

                const borrowedSf = readU128LE(rd, offset); offset += 16;
                console.log(`[${offset - 16}] borrowed_amount_sf: ${borrowedSf}`);

                const cumBorrowRate = readU128LE(rd, offset); offset += 16;
                console.log(`[${offset - 16}] cumulative_borrow_rate_sf: ${cumBorrowRate}`);

                console.log(`\nCurrent offset after sequential liquidity reads: ${offset}`);

                // Search for collateral mint (should be a valid pubkey around offset 400-600)
                console.log("\n--- Scanning for collateral fields (offset 400-650) ---");
                for (let o = 400; o < 650; o += 32) {
                    const pk = readPubkey(rd, o);
                    // Check if it's a valid-looking pubkey (not all zeros)
                    if (pk !== "11111111111111111111111111111111") {
                        console.log(`  [${o}] pubkey: ${pk}`);
                    }
                }

                // Search for config byte fields (LTV, liquidation threshold, status)
                console.log("\n--- Scanning for LTV/config bytes (offset 600-800) ---");
                for (let o = 600; o < Math.min(800, rd.length); o++) {
                    const v = readU8(rd, o);
                    if (v >= 50 && v <= 95) {
                        console.log(`  [${o}] u8=${v} (possible LTV/threshold)`);
                    }
                }
            }
        }
    } catch (e: any) {
        console.log("getProgramAccounts failed (may be rate-limited):", e.message?.slice(0, 100));
        console.log("Try setting SOLANA_RPC_URL to a private RPC endpoint");
    }
}

main().catch(console.error);
