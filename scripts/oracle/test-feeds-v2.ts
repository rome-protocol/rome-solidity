import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { toHex } from "viem";

/**
 * Oracle Gateway V2 — Integration test on monti_spl.
 *
 * Tests:
 *   1. Create Pyth Pull feeds for SOL/USD, BTC/USD, ETH/USD
 *   2. Read prices via latestRoundData()
 *   3. Read extended data via latestPriceData() and latestEMAData()
 *   4. Verify Chainlink interface compliance
 *   5. Test duplicate feed prevention
 *   6. Test pause/unpause
 *   7. Test BatchReader
 *
 * PriceFeedAccount PDAs (shard_id=0, owner=pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT):
 *   SOL/USD: 7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE (0x60314704340deddf371fd42472148f248e9d1a6d1a5eb2ac3acd8b7fd5d6b243)
 *   BTC/USD: 4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo (0x35a70c11162fbf5a0e7f7d2f96e19f97b02246a15687ee672794897448e658de)
 *   ETH/USD: 42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC (0x2cfad277afcaa867c7d7fe26e0d51dc899101335879ab63c2aa84876317135bb)
 */

// Feed PDAs (shard_id=0) as bytes32
const PYTH_FEEDS: Record<string, `0x${string}`> = {
    "SOL / USD": "0x60314704340deddf371fd42472148f248e9d1a6d1a5eb2ac3acd8b7fd5d6b243",
    "BTC / USD": "0x35a70c11162fbf5a0e7f7d2f96e19f97b02246a15687ee672794897448e658de",
    "ETH / USD": "0x2cfad277afcaa867c7d7fe26e0d51dc899101335879ab63c2aa84876317135bb",
};

async function main() {
    const { viem, networkName } = await hardhat.network.connect();
    const publicClient = await viem.getPublicClient();

    // Read deployment
    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);
    const deployments = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const v2 = deployments.OracleGatewayV2;
    if (!v2) {
        throw new Error(
            `OracleGatewayV2 block not found in ${filePath}. Run deploy-v2-polish.ts first.`,
        );
    }
    // deploy-v2-polish.ts writes plain strings; legacy scripts (setup-local.ts,
    // deploy.ts) still write { address: ... }. Handle both shapes.
    const factoryAddress: `0x${string}` =
        typeof v2.OracleAdapterFactory === "string"
            ? v2.OracleAdapterFactory
            : v2.OracleAdapterFactory.address;
    const batchReaderAddress: `0x${string}` =
        typeof v2.BatchReader === "string" ? v2.BatchReader : v2.BatchReader.address;

    console.log("=== Oracle Gateway V2 Integration Tests ===");
    console.log("Factory:", factoryAddress);
    console.log("BatchReader:", batchReaderAddress);
    console.log();

    const factory = await viem.getContractAt(
        "OracleAdapterFactory",
        factoryAddress,
    );

    // ─── 1. Create Pyth Pull feeds ───
    console.log("=== 1. Creating Pyth Pull feeds ===");
    const adapterAddresses: string[] = [];

    for (const [pair, pubkey] of Object.entries(PYTH_FEEDS)) {
        console.log(`\nCreating ${pair}...`);
        console.log("  PDA:", pubkey);

        const existing = await factory.read.pythAdapters([pubkey]);
        if (existing !== "0x0000000000000000000000000000000000000000") {
            console.log("  Already exists:", existing);
            adapterAddresses.push(existing);
            continue;
        }

        try {
            const txHash = await factory.write.createPythFeed([pubkey, pair, 0n]);
            console.log("  Tx:", txHash);
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            console.log("  Status:", receipt.status);

            const adapterAddr = await factory.read.pythAdapters([pubkey]);
            console.log("  Adapter:", adapterAddr);
            adapterAddresses.push(adapterAddr);
        } catch (e: any) {
            console.error("  FAILED:", e.cause?.reason ?? e.message?.slice(0, 100));
        }
    }

    console.log("\nTotal adapters:", (await factory.read.adapterCount()).toString());

    // ─── 2. Read prices ───
    console.log("\n=== 2. Read prices via latestRoundData() ===");
    for (let i = 0; i < adapterAddresses.length; i++) {
        const addr = adapterAddresses[i];
        const pair = Object.keys(PYTH_FEEDS)[i];
        try {
            const adapter = await viem.getContractAt("PythPullAdapter", addr as `0x${string}`);
            const [roundId, answer, , updatedAt, answeredInRound] =
                await adapter.read.latestRoundData();
            const desc = await adapter.read.description();
            console.log(`\n${desc} (${addr})`);
            console.log(`  price: $${(Number(answer) / 1e8).toFixed(4)} (raw: ${answer})`);
            console.log(`  roundId=${roundId} answeredInRound=${answeredInRound}`);
            console.log(`  updatedAt: ${updatedAt} (${new Date(Number(updatedAt) * 1000).toISOString()})`);
            console.log(`  age: ${Math.floor(Date.now() / 1000) - Number(updatedAt)}s`);
        } catch (e: any) {
            console.log(`\n${pair} (${addr}): REVERTED — ${e.cause?.reason ?? e.message?.slice(0, 80)}`);
        }
    }

    // ─── 3. Extended data ───
    console.log("\n=== 3. Extended data (latestPriceData + latestEMAData) ===");
    if (adapterAddresses[0]) {
        const adapter = await viem.getContractAt("PythPullAdapter", adapterAddresses[0] as `0x${string}`);
        try {
            const [price, conf, expo, publishTime] = await adapter.read.latestPriceData();
            console.log("latestPriceData:");
            console.log(`  price=${price} conf=${conf} expo=${expo} publishTime=${publishTime}`);

            const [emaPrice, emaConf, emaExpo, emaPublishTime] = await adapter.read.latestEMAData();
            console.log("latestEMAData:");
            console.log(`  emaPrice=${emaPrice} emaConf=${emaConf} expo=${emaExpo} publishTime=${emaPublishTime}`);

            const status = await adapter.read.priceStatus();
            console.log(`priceStatus: ${status} (0=Trading, 1=Stale, 2=Paused)`);

            const oType = await adapter.read.oracleType();
            console.log(`oracleType: ${oType} (0=PythPull)`);
        } catch (e: any) {
            console.log("Extended data read failed:", e.cause?.reason ?? e.message?.slice(0, 80));
        }
    }

    // ─── 4. Chainlink compliance checks ───
    console.log("\n=== 4. Chainlink interface compliance ===");
    if (adapterAddresses[0]) {
        const adapter = await viem.getContractAt("PythPullAdapter", adapterAddresses[0] as `0x${string}`);
        try {
            const [roundId, answer, , updatedAt, answeredInRound] = await adapter.read.latestRoundData();
            const checks = [
                ["roundId > 0", roundId > 0],
                ["answer > 0", answer > 0n],
                ["updatedAt > 0", updatedAt > 0n],
                ["answeredInRound >= roundId", answeredInRound >= roundId],
                ["decimals == 8", (await adapter.read.decimals()) === 8],
                ["version == 2", (await adapter.read.version()) === 2n],
                ["description non-empty", (await adapter.read.description()).length > 0],
            ];
            for (const [name, ok] of checks) {
                console.log(`  ${ok ? "PASS" : "FAIL"}: ${name}`);
            }
        } catch (e: any) {
            console.log("Compliance check failed:", e.cause?.reason ?? e.message?.slice(0, 80));
        }
    }

    // ─── 5. Duplicate prevention ───
    console.log("\n=== 5. Duplicate feed prevention ===");
    const firstPubkey = Object.values(PYTH_FEEDS)[0];
    try {
        await factory.write.createPythFeed([firstPubkey, "DUP", 0n]);
        console.log("  FAIL: should have reverted");
    } catch (e: any) {
        console.log("  PASS: reverted (duplicate prevented)");
    }

    // ─── 6. Pause/unpause ───
    console.log("\n=== 6. Pause/unpause ===");
    if (adapterAddresses[0]) {
        const addr = adapterAddresses[0] as `0x${string}`;
        try {
            // Pause
            const pauseTx = await factory.write.pauseAdapter([addr]);
            await publicClient.waitForTransactionReceipt({ hash: pauseTx });
            const paused = await factory.read.isPaused([addr]);
            console.log(`  Paused: ${paused} (expected: true) — ${paused ? "PASS" : "FAIL"}`);

            // Try to read — should revert
            const adapter = await viem.getContractAt("PythPullAdapter", addr);
            try {
                await adapter.read.latestRoundData();
                console.log("  FAIL: paused adapter should revert");
            } catch {
                console.log("  PASS: paused adapter reverts on read");
            }

            // Check priceStatus returns 2 (Paused)
            const status = await adapter.read.priceStatus();
            console.log(`  priceStatus while paused: ${status} (expected: 2) — ${status === 2 ? "PASS" : "FAIL"}`);

            // Unpause
            const unpauseTx = await factory.write.unpauseAdapter([addr]);
            await publicClient.waitForTransactionReceipt({ hash: unpauseTx });
            const unpaused = !(await factory.read.isPaused([addr]));
            console.log(`  Unpaused: ${unpaused} (expected: true) — ${unpaused ? "PASS" : "FAIL"}`);

            // Should read again
            try {
                await adapter.read.latestRoundData();
                console.log("  PASS: unpaused adapter reads successfully");
            } catch (e: any) {
                console.log("  Post-unpause read:", e.cause?.reason ?? e.message?.slice(0, 80));
            }
        } catch (e: any) {
            console.log("  Pause test failed:", e.cause?.reason ?? e.message?.slice(0, 80));
        }
    }

    // ─── 7. BatchReader ───
    console.log("\n=== 7. BatchReader ===");
    const batchReader = await viem.getContractAt("BatchReader", batchReaderAddress);
    try {
        const results = await batchReader.read.getLatestPrices([
            adapterAddresses as `0x${string}`[],
        ]);
        console.log(`  ${results.length} results:`);
        for (const r of results) {
            console.log(`    ${r.adapter}: $${(Number(r.answer) / 1e8).toFixed(4)} success=${r.success}`);
        }
    } catch (e: any) {
        console.log("  BatchReader failed:", e.cause?.reason ?? e.message?.slice(0, 80));
    }

    // ─── Save feed deployments ───
    const feedDeployments = Object.entries(PYTH_FEEDS).map(([pair, pubkey], i) => ({
        pair,
        pythAccountBytes32: pubkey,
        adapter: adapterAddresses[i] ?? null,
    }));

    deployments.OracleGatewayV2.feedsVerified = feedDeployments;
    fs.writeFileSync(filePath, JSON.stringify(deployments, null, 2) + "\n", "utf8");
    console.log("\nDeployments updated:", filePath);

    console.log("\n=== Done ===");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
