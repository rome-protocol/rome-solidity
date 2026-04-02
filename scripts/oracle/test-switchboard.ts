import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";

/**
 * Test Switchboard V2 SOL/USD feed on monti_spl.
 *
 * SOL/USD aggregator: GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR
 *   bytes32: 0xec81105112a257d61df4cf5f13ee0a1b019197c8c5343b4f2a7ec8846ae22c1a
 *   owner: SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f
 */

const SB_SOL_USD = "0xec81105112a257d61df4cf5f13ee0a1b019197c8c5343b4f2a7ec8846ae22c1a" as const;

async function main() {
    const { viem, networkName } = await hardhat.network.connect();
    const publicClient = await viem.getPublicClient();

    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);
    const deployments = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const v2 = deployments.OracleGatewayV2;

    console.log("=== Switchboard V2 Integration Test ===");
    console.log("Factory:", v2.OracleAdapterFactory.address);
    console.log();

    const factory = await viem.getContractAt(
        "OracleAdapterFactory",
        v2.OracleAdapterFactory.address,
    );

    // ─── Create SOL/USD Switchboard feed ───
    console.log("Creating Switchboard SOL/USD feed...");
    console.log("  Account:", SB_SOL_USD);

    const existing = await factory.read.switchboardAdapters([SB_SOL_USD]);
    let adapterAddr: string;

    if (existing !== "0x0000000000000000000000000000000000000000") {
        console.log("  Already exists:", existing);
        adapterAddr = existing;
    } else {
        try {
            const txHash = await factory.write.createSwitchboardFeed([SB_SOL_USD, "SOL / USD (Switchboard)", 0n]);
            console.log("  Tx:", txHash);
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            console.log("  Status:", receipt.status);

            adapterAddr = await factory.read.switchboardAdapters([SB_SOL_USD]);
            console.log("  Adapter:", adapterAddr);
        } catch (e: any) {
            console.error("  FAILED:", e.cause?.reason ?? e.message?.slice(0, 150));
            return;
        }
    }

    // ─── Read price ───
    console.log("\n=== Read Switchboard price ===");
    const adapter = await viem.getContractAt("SwitchboardV3Adapter", adapterAddr as `0x${string}`);

    try {
        const [roundId, answer, , updatedAt, answeredInRound] = await adapter.read.latestRoundData();
        const desc = await adapter.read.description();
        console.log(`${desc}:`);
        console.log(`  price: $${(Number(answer) / 1e8).toFixed(4)} (raw: ${answer})`);
        console.log(`  roundId=${roundId} answeredInRound=${answeredInRound}`);
        console.log(`  updatedAt: ${updatedAt} (${new Date(Number(updatedAt) * 1000).toISOString()})`);
        console.log(`  age: ${Math.floor(Date.now() / 1000) - Number(updatedAt)}s`);
    } catch (e: any) {
        console.log(`  latestRoundData REVERTED: ${e.cause?.reason ?? e.message?.slice(0, 100)}`);
    }

    // ─── Extended data ───
    console.log("\n=== Extended data ===");
    try {
        const [price, conf, expo, publishTime] = await adapter.read.latestPriceData();
        console.log(`  price=${price} conf=${conf} expo=${expo} publishTime=${publishTime}`);
    } catch (e: any) {
        console.log(`  latestPriceData: ${e.cause?.reason ?? e.message?.slice(0, 80)}`);
    }

    try {
        await adapter.read.latestEMAData();
        console.log("  FAIL: EMA should revert for Switchboard");
    } catch {
        console.log("  PASS: latestEMAData correctly reverts (EMANotSupported)");
    }

    console.log(`  oracleType: ${await adapter.read.oracleType()} (expected: 1 = SwitchboardV3)`);
    console.log(`  version: ${await adapter.read.version()} (expected: 2)`);
    console.log(`  decimals: ${await adapter.read.decimals()} (expected: 8)`);

    // ─── Price status ───
    console.log("\n=== Price status ===");
    try {
        const status = await adapter.read.priceStatus();
        console.log(`  status: ${status} (0=Trading, 1=Stale, 2=Paused)`);
    } catch (e: any) {
        console.log(`  priceStatus: ${e.cause?.reason ?? e.message?.slice(0, 80)}`);
    }

    // ─── BatchReader with mixed Pyth + Switchboard ───
    console.log("\n=== BatchReader (mixed Pyth + Switchboard) ===");
    // Also create a Pyth feed if it doesn't exist
    const pythSolPda = "0x60314704340deddf371fd42472148f248e9d1a6d1a5eb2ac3acd8b7fd5d6b243" as const;
    let pythAddr = await factory.read.pythAdapters([pythSolPda]);
    if (pythAddr === "0x0000000000000000000000000000000000000000") {
        try {
            const tx = await factory.write.createPythFeed([pythSolPda, "SOL / USD (Pyth)", 0n]);
            await publicClient.waitForTransactionReceipt({ hash: tx });
            pythAddr = await factory.read.pythAdapters([pythSolPda]);
            console.log("  Created Pyth SOL/USD:", pythAddr);
        } catch (e: any) {
            console.log("  Pyth feed creation failed:", e.cause?.reason ?? e.message?.slice(0, 80));
        }
    }

    const batchReader = await viem.getContractAt("BatchReader", v2.BatchReader.address);
    const adapters = [pythAddr, adapterAddr].filter(a => a !== "0x0000000000000000000000000000000000000000");
    try {
        const results = await batchReader.read.getLatestPrices([adapters as `0x${string}`[]]);
        for (const r of results) {
            console.log(`  ${r.adapter}: $${(Number(r.answer) / 1e8).toFixed(4)} success=${r.success}`);
        }
    } catch (e: any) {
        console.log(`  BatchReader failed: ${e.cause?.reason ?? e.message?.slice(0, 80)}`);
    }

    // ─── Save ───
    deployments.OracleGatewayV2.switchboardFeeds = [{
        pair: "SOL/USD",
        aggregator: "GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR",
        aggregatorBytes32: SB_SOL_USD,
        adapter: adapterAddr,
    }];
    fs.writeFileSync(filePath, JSON.stringify(deployments, null, 2) + "\n", "utf8");

    console.log("\n=== Done ===");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
