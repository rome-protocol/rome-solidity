import hardhat from "hardhat";

/**
 * Pyth Pull Receiver — Offset Validation Script
 *
 * Reads a live PriceUpdateV2 PDA via CPI precompile and validates that
 * PythPullParser's byte offsets produce reasonable values.
 *
 * Usage:
 *   PYTH_PULL_ACCOUNT=0x... npx hardhat run scripts/oracle/validate-pyth-pull-offsets.ts --network monti_spl
 */

async function main() {
    const pythPullAccount = process.env.PYTH_PULL_ACCOUNT;
    if (!pythPullAccount) {
        throw new Error("PYTH_PULL_ACCOUNT env var required (bytes32 hex of a live PriceUpdateV2 PDA)");
    }

    const { viem } = await hardhat.network.connect();

    console.log("=== Pyth Pull Offset Validation ===");
    console.log("Account:", pythPullAccount);
    console.log();

    // Deploy the parser harness
    const parser = await viem.deployContract("PythPullParserHarness", []);

    // Read raw account data via CPI precompile
    const publicClient = await viem.getPublicClient();
    const cpiAddress = "0xFF00000000000000000000000000000000000008";

    // Read account info through the parser harness's ability to interact with CPI
    // We'll do it via a helper contract, or directly read and parse
    // For validation, deploy a small reader that calls account_info and returns raw data

    // Actually, use the parser directly - if it can parse, offsets are correct
    try {
        const [price, conf, expo, publishTime, emaPrice, emaConf] =
            await parser.read.parse([pythPullAccount]);

        console.log("Parsed fields:");
        console.log(`  price:       ${price} (int64)`);
        console.log(`  conf:        ${conf} (uint64)`);
        console.log(`  expo:        ${expo} (int32)`);
        console.log(`  publishTime: ${publishTime} (uint64) → ${new Date(Number(publishTime) * 1000).toISOString()}`);
        console.log(`  emaPrice:    ${emaPrice} (int64)`);
        console.log(`  emaConf:     ${emaConf} (uint64)`);
        console.log();

        // Reasonableness checks
        let passed = true;

        if (expo > 0 || expo < -18) {
            console.error(`FAIL: exponent ${expo} is outside expected range [-18, 0]`);
            passed = false;
        } else {
            console.log(`PASS: exponent ${expo} is within expected range`);
        }

        if (price <= 0) {
            console.error(`FAIL: price ${price} is not positive`);
            passed = false;
        } else {
            console.log(`PASS: price ${price} is positive`);
        }

        const now = Math.floor(Date.now() / 1000);
        const age = now - Number(publishTime);
        if (age < 0 || age > 86400) {
            console.warn(`WARN: publishTime age is ${age}s (expected <24h). Feed may be stale.`);
        } else {
            console.log(`PASS: publishTime is ${age}s old (recent)`);
        }

        if (conf === 0n) {
            console.warn("WARN: confidence is 0 — unusual but not invalid");
        } else {
            console.log(`PASS: confidence ${conf} is non-zero`);
        }

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
