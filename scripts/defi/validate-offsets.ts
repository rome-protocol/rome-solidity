import { Connection, PublicKey } from "@solana/web3.js";

/**
 * Solana State SDK — Offset Validation Script
 *
 * Fetches real Drift v2 and Kamino Lending accounts from mainnet Solana,
 * parses them using the same byte offsets as our Solidity contracts,
 * and validates parsed values are reasonable.
 *
 * Usage:
 *   npx tsx scripts/defi/validate-offsets.ts
 *   SOLANA_RPC_URL=https://... npx tsx scripts/defi/validate-offsets.ts
 */

function readU8(d: Buffer, o: number): number { return d.readUInt8(o); }
function readU16LE(d: Buffer, o: number): number { return d.readUInt16LE(o); }
function readU64LE(d: Buffer, o: number): bigint { return d.readBigUInt64LE(o); }
function readI64LE(d: Buffer, o: number): bigint { return d.readBigInt64LE(o); }
function readU128LE(d: Buffer, o: number): bigint {
    return (d.readBigUInt64LE(o + 8) << 64n) | d.readBigUInt64LE(o);
}
function readI128LE(d: Buffer, o: number): bigint {
    const u = readU128LE(d, o);
    return u >= (1n << 127n) ? u - (1n << 128n) : u;
}
function readPubkey(d: Buffer, o: number): string {
    return new PublicKey(d.subarray(o, o + 32)).toBase58();
}

interface Result { field: string; offset: number; value: string; pass: boolean; note: string; }

const DRIFT = new PublicKey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");

async function main() {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
    const conn = new Connection(rpcUrl, "confirmed");
    let totalPass = 0, totalFail = 0;

    function print(title: string, results: Result[]) {
        console.log(`\n─── ${title} ───`);
        for (const r of results) {
            const icon = r.pass ? "✓" : "✗";
            const v = r.value.length > 70 ? r.value.slice(0, 67) + "..." : r.value;
            console.log(`  ${icon} [${r.offset}] ${r.field} = ${v}`);
            if (!r.pass) console.log(`       FAIL: ${r.note}`);
            r.pass ? totalPass++ : totalFail++;
        }
    }

    // ═══ Drift PerpMarket (validated offsets) ═══

    for (const [idx, name] of [[0, "SOL-PERP"], [1, "ETH-PERP"]] as const) {
        const pda = PublicKey.findProgramAddressSync(
            [Buffer.from("perp_market"), Buffer.from([idx, 0])], DRIFT
        )[0];
        console.log(`\nFetching Drift PerpMarket ${idx} (${name}): ${pda.toBase58()}`);
        const info = await conn.getAccountInfo(pda);
        if (!info) { console.error("NOT FOUND"); totalFail++; continue; }
        const d = Buffer.from(info.data);
        const r: Result[] = [];

        r.push({ field: "length", offset: 0, value: `${d.length}`, pass: d.length >= 1216, note: ">= 1216" });
        r.push({ field: "owner", offset: 0, value: info.owner.toBase58(), pass: info.owner.equals(DRIFT), note: "Drift program" });

        const oracle = readPubkey(d, 40);
        r.push({ field: "amm.oracle", offset: 40, value: oracle, pass: oracle.length > 30, note: "Valid pubkey" });

        const bar = readU128LE(d, 176);
        r.push({ field: "amm.base_asset_reserve", offset: 176, value: bar.toString(), pass: bar > 0n, note: "Non-zero" });

        const qar = readU128LE(d, 192);
        r.push({ field: "amm.quote_asset_reserve", offset: 192, value: qar.toString(), pass: qar > 0n, note: "Non-zero" });

        const cfl = readI128LE(d, 560);
        r.push({ field: "amm.cum_funding_long", offset: 560, value: cfl.toString(), pass: true, note: "Any value" });

        const cfs = readI128LE(d, 576);
        r.push({ field: "amm.cum_funding_short", offset: 576, value: cfs.toString(), pass: true, note: "Any value" });

        const ts = Number(readI64LE(d, 792));
        const now = Math.floor(Date.now() / 1000);
        r.push({ field: "amm.last_funding_rate_ts", offset: 792, value: `${ts} (${new Date(ts * 1000).toISOString()})`,
            pass: ts > 1700000000 && ts < now + 86400, note: `Age: ${now - ts}s` });

        const mi = readU16LE(d, 1160);
        r.push({ field: "market_index", offset: 1160, value: `${mi}`, pass: mi === idx, note: `Expected ${idx}` });

        const st = readU8(d, 1162);
        r.push({ field: "status", offset: 1162, value: `${st}`, pass: st <= 5, note: "MarketStatus enum" });

        print(`Drift PerpMarket ${idx} (${name})`, r);
    }

    // ═══ Drift SpotMarket (validated offsets) ═══

    const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

    for (const [idx, name, expectedMint, expectedDec] of [
        [0, "USDC", USDC_MINT, 6],
        [1, "SOL", SOL_MINT, 9],
    ] as const) {
        const pda = PublicKey.findProgramAddressSync(
            [Buffer.from("spot_market"), Buffer.from([idx as number, 0])], DRIFT
        )[0];
        console.log(`\nFetching Drift SpotMarket ${idx} (${name}): ${pda.toBase58()}`);
        const info = await conn.getAccountInfo(pda);
        if (!info) { console.error("NOT FOUND"); totalFail++; continue; }
        const d = Buffer.from(info.data);
        const r: Result[] = [];

        r.push({ field: "length", offset: 0, value: `${d.length}`, pass: d.length >= 776, note: ">= 776" });

        const oracle = readPubkey(d, 40);
        r.push({ field: "oracle", offset: 40, value: oracle, pass: oracle.length > 30, note: "Valid pubkey" });

        const mint = readPubkey(d, 72);
        r.push({ field: "mint", offset: 72, value: mint, pass: mint === expectedMint.toBase58(), note: `Expected ${name} mint` });

        const vault = readPubkey(d, 104);
        r.push({ field: "vault", offset: 104, value: vault, pass: vault.length > 30, note: "Valid pubkey" });

        const db = readU128LE(d, 432);
        r.push({ field: "deposit_balance", offset: 432, value: db.toString(), pass: db > 0n, note: "Non-zero" });

        const bb = readU128LE(d, 448);
        r.push({ field: "borrow_balance", offset: 448, value: bb.toString(), pass: true, note: "Can be zero" });

        const cdi = readU128LE(d, 464);
        r.push({ field: "cum_deposit_interest", offset: 464, value: cdi.toString(), pass: cdi > 0n, note: "Non-zero" });

        const cbi = readU128LE(d, 480);
        r.push({ field: "cum_borrow_interest", offset: 480, value: cbi.toString(), pass: cbi > 0n, note: "Non-zero" });

        const dec = readU8(d, 680);
        r.push({ field: "decimals", offset: 680, value: `${dec}`, pass: dec === expectedDec, note: `Expected ${expectedDec}` });

        const mi = readU16LE(d, 684);
        r.push({ field: "market_index", offset: 684, value: `${mi}`, pass: mi === idx, note: `Expected ${idx}` });

        const st = readU8(d, 688);
        r.push({ field: "status", offset: 688, value: `${st}`, pass: st <= 5, note: "MarketStatus enum" });

        print(`Drift SpotMarket ${idx} (${name})`, r);
    }

    // ═══ Kamino Lending (header validated) ═══

    const KAMINO = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
    const kaminoReserve = new PublicKey("H3t6qZ1JkguCNTi9uzVKqQ7dvt2cum4XiXWom6Gn5e5S");
    console.log(`\nFetching Kamino Reserve: ${kaminoReserve.toBase58()}`);
    const kInfo = await conn.getAccountInfo(kaminoReserve);
    if (!kInfo) {
        console.error("NOT FOUND"); totalFail++;
    } else {
        const d = Buffer.from(kInfo.data);
        const r: Result[] = [];

        r.push({ field: "length", offset: 0, value: `${d.length}`, pass: d.length >= 8624, note: ">= 8624" });
        r.push({ field: "owner", offset: 0, value: kInfo.owner.toBase58(), pass: kInfo.owner.equals(KAMINO), note: "Kamino program" });

        const lm = readPubkey(d, 25);
        r.push({ field: "lending_market", offset: 25, value: lm, pass: lm.length > 30, note: "Valid pubkey" });

        const liqMint = readPubkey(d, 57);
        r.push({ field: "liquidity_mint", offset: 57, value: liqMint, pass: liqMint.length > 30, note: "Valid pubkey" });

        const supVault = readPubkey(d, 89);
        r.push({ field: "supply_vault", offset: 89, value: supVault, pass: supVault.length > 30, note: "Valid pubkey" });

        const oracle = readPubkey(d, 153);
        r.push({ field: "oracle", offset: 153, value: oracle, pass: oracle.length > 30, note: "Valid pubkey (after fee_vault)" });

        const avail = readU64LE(d, 185);
        r.push({ field: "available_amount", offset: 185, value: avail.toString(), pass: true, note: "Can be any value" });

        const borrowed = readU128LE(d, 193);
        r.push({ field: "borrowed_amount_sf", offset: 193, value: borrowed.toString(), pass: true, note: "Scaled fraction" });

        const cumRate = readU128LE(d, 209);
        r.push({ field: "cum_borrow_rate_sf", offset: 209, value: cumRate.toString(), pass: cumRate > 0n, note: "Non-zero" });

        print("Kamino Lending Reserve (header)", r);
        console.log("\n  ⚠ Kamino collateral/config offsets (520, 700-702) not yet validated.");
        console.log("    Use a private RPC with getProgramAccounts to find USDC reserves.");
    }

    // ═══ Summary ═══
    console.log("\n═══════════════════════════════════════");
    console.log(`  PASSED: ${totalPass}`);
    console.log(`  FAILED: ${totalFail}`);
    console.log("═══════════════════════════════════════");
    if (totalFail > 0) { console.error("\nValidation had failures."); process.exitCode = 1; }
    else { console.log("\nAll validated offsets are correct."); }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
