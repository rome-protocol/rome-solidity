import hardhat from "hardhat";

/**
 * Switchboard V3 — Offset Validation Script
 *
 * Reads a live Switchboard V3 AggregatorAccountData via CPI precompile and
 * validates that SwitchboardParser's byte offsets produce reasonable values.
 *
 * Usage:
 *   SWITCHBOARD_ACCOUNT=0x... npx hardhat run scripts/oracle/validate-switchboard-offsets.ts --network monti_spl
 */

async function main() {
    const switchboardAccount = process.env.SWITCHBOARD_ACCOUNT;
    if (!switchboardAccount) {
        throw new Error("SWITCHBOARD_ACCOUNT env var required (bytes32 hex of a live Switchboard aggregator)");
    }

    const { viem } = await hardhat.network.connect();

    console.log("=== Switchboard V3 Offset Validation ===");
    console.log("Account:", switchboardAccount);
    console.log();

    // Deploy the parser harness
    const parser = await viem.deployContract("SwitchboardParserHarness", []);

    try {
        const [mantissa, scale, timestamp, slot] =
            await parser.read.parse([switchboardAccount]);

        console.log("Parsed fields:");
        console.log(`  mantissa:  ${mantissa} (int128)`);
        console.log(`  scale:     ${scale} (uint32)`);
        console.log(`  timestamp: ${timestamp} (int64) → ${new Date(Number(timestamp) * 1000).toISOString()}`);
        console.log(`  slot:      ${slot} (uint64)`);
        console.log();

        let passed = true;

        if (scale > 18) {
            console.error(`FAIL: scale ${scale} is unusually large (expected <= 18)`);
            passed = false;
        } else {
            console.log(`PASS: scale ${scale} is within expected range`);
        }

        if (mantissa === 0n) {
            console.warn("WARN: mantissa is 0 — feed may not be active");
        } else if (mantissa < 0n) {
            console.warn(`WARN: mantissa ${mantissa} is negative — unusual for price feeds`);
        } else {
            console.log(`PASS: mantissa ${mantissa} is positive`);
        }

        const now = Math.floor(Date.now() / 1000);
        const age = now - Number(timestamp);
        if (age < 0 || age > 86400) {
            console.warn(`WARN: timestamp age is ${age}s (expected <24h). Feed may be stale.`);
        } else {
            console.log(`PASS: timestamp is ${age}s old (recent)`);
        }

        // Try to compute a human-readable price
        const price = Number(mantissa) / Math.pow(10, Number(scale));
        console.log(`  Derived price: $${price.toFixed(4)}`);

        console.log();
        if (passed) {
            console.log("=== VALIDATION PASSED ===");
        } else {
            console.error("=== VALIDATION FAILED ===");
            process.exitCode = 1;
        }
    } catch (err: any) {
        console.error("FAIL: Parser reverted:", err.message);
        console.error("Offsets may be incorrect or account data format has changed.");
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
