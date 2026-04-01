import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { toHex } from "viem";

/**
 * Test oracle feeds on monti_spl. Uses existing factory deployment
 * or deploys a new one. Creates BTC/USD and ETH/USD feed adapters
 * and runs full verification.
 */

const FACTORY_ADDRESS = "0x05382ec336f797fcbeddcb0fef8288fb4f26e072";
const SOL_ADAPTER_ADDRESS = "0x170dDC928429FC1A55Dc31c7f5793fc1b2Afea08";

// Pyth devnet v1 price accounts (owned by gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s)
const FEEDS = {
    "BTC/USD": "HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J",
    "ETH/USD": "EdVCmQ9FSPcVe5YySXDPCRmc8aDQLKJ9xvYBMZPie1Vw",
};

async function main() {
    const { viem, networkName } = await hardhat.network.connect();
    const publicClient = await viem.getPublicClient();

    const systemProgram = await viem.getContractAt(
        "ISystemProgram",
        "0xfF00000000000000000000000000000000000007",
    );

    const factory = await viem.getContractAt(
        "PythAggregatorFactory",
        FACTORY_ADDRESS,
    );

    console.log("Factory:", FACTORY_ADDRESS);
    console.log("Total feeds:", (await factory.read.totalFeeds()).toString());

    // ─── Test existing SOL/USD adapter ───
    console.log("\n=== SOL/USD (existing) ===");
    const solAdapter = await viem.getContractAt("PythAggregatorV3", SOL_ADAPTER_ADDRESS);
    await printAdapterState(solAdapter);

    // ─── Create new feeds ───
    const deployedFeeds: { pair: string; pubkey: string; adapter: string }[] = [];

    for (const [pair, base58] of Object.entries(FEEDS)) {
        console.log(`\n=== Creating ${pair} ===`);
        const pubkey = await systemProgram.read.base58_to_bytes32([
            toHex(Buffer.from(base58)),
        ]);
        console.log("Pubkey (bytes32):", pubkey);

        // Check if already exists
        const existing = await factory.read.feedAdapters([pubkey]);
        if (existing !== "0x0000000000000000000000000000000000000000") {
            console.log("Already deployed at:", existing);
            const adapter = await viem.getContractAt("PythAggregatorV3", existing);
            await printAdapterState(adapter);
            deployedFeeds.push({ pair, pubkey, adapter: existing });
            continue;
        }

        const txHash = await factory.write.createFeed([pubkey, pair]);
        console.log("Tx:", txHash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log("Status:", receipt.status);

        const adapterAddr = await factory.read.feedAdapters([pubkey]);
        console.log("Adapter:", adapterAddr);

        const adapter = await viem.getContractAt("PythAggregatorV3", adapterAddr as `0x${string}`);
        await printAdapterState(adapter);
        deployedFeeds.push({ pair, pubkey, adapter: adapterAddr as string });
    }

    console.log("\nTotal feeds:", (await factory.read.totalFeeds()).toString());

    // ─── Verification tests ───
    console.log("\n=== Verification Tests ===");

    // Test 1: Duplicate prevention
    console.log("\n1. Duplicate feed prevention:");
    const solPubkey = await systemProgram.read.base58_to_bytes32([
        toHex(Buffer.from("J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix")),
    ]);
    try {
        await factory.write.createFeed([solPubkey, "SOL/USD dup"]);
        console.log("   FAIL: should have reverted");
    } catch (e: any) {
        console.log("   PASS: reverted with:", e.cause?.reason ?? e.message?.slice(0, 60));
    }

    // Test 2: getRoundData reverts
    console.log("\n2. getRoundData reverts:");
    const solAdapter2 = await viem.getContractAt("PythAggregatorV3", SOL_ADAPTER_ADDRESS);
    try {
        await solAdapter2.read.getRoundData([1]);
        console.log("   FAIL: should have reverted");
    } catch (e: any) {
        console.log("   PASS: reverted with:", e.cause?.reason ?? e.message?.slice(0, 60));
    }

    // Test 3: Non-Pyth account rejection
    console.log("\n3. Non-Pyth account rejection:");
    // Use a random system account that isn't owned by Pyth
    const fakePubkey = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
    try {
        await factory.write.createFeed([fakePubkey, "FAKE"]);
        console.log("   FAIL: should have reverted");
    } catch (e: any) {
        console.log("   PASS: reverted with:", e.cause?.reason ?? e.message?.slice(0, 60));
    }

    // Test 4: Interface compliance — all Chainlink fields present
    console.log("\n4. Chainlink interface compliance:");
    const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        await solAdapter2.read.latestRoundData();
    const checks = [
        ["roundId > 0", roundId > 0],
        ["answer > 0", answer > 0n],
        ["updatedAt > 0", updatedAt > 0n],
        ["answeredInRound >= roundId", answeredInRound >= roundId],
        ["decimals == 8", (await solAdapter2.read.decimals()) === 8],
        ["version == 1", (await solAdapter2.read.version()) === 1n],
        ["description non-empty", (await solAdapter2.read.description()).length > 0],
        ["latestRound == 1", (await solAdapter2.read.latestRound()) === 1n],
    ];
    for (const [name, ok] of checks) {
        console.log(`   ${ok ? "PASS" : "FAIL"}: ${name}`);
    }

    // Test 5: latestAnswer matches latestRoundData
    console.log("\n5. Consistency check:");
    const la = await solAdapter2.read.latestAnswer();
    const lt = await solAdapter2.read.latestTimestamp();
    console.log(`   latestAnswer: ${la} === answer: ${answer} → ${la === answer ? "PASS" : "FAIL"}`);
    console.log(`   latestTimestamp: ${lt} === updatedAt: ${updatedAt} → ${lt === updatedAt ? "PASS" : "FAIL"}`);

    // ─── Save deployments ───
    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);
    let content: any = {};
    if (fs.existsSync(filePath)) {
        content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    content.PythAggregatorFactory = { address: FACTORY_ADDRESS };
    content.PythAggregatorFeeds = [
        {
            pair: "SOL/USD",
            pythAccountBase58: "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix",
            adapter: SOL_ADAPTER_ADDRESS,
        },
        ...deployedFeeds.map((f) => ({
            pair: f.pair,
            pythAccount: f.pubkey,
            adapter: f.adapter,
        })),
    ];

    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf8");
    console.log("\nDeployments saved to:", filePath);
    console.log("\nDone.");
}

async function printAdapterState(adapter: any) {
    const desc = await adapter.read.description();
    const decimals = await adapter.read.decimals();

    const [roundId, answer, , updatedAt, answeredInRound] =
        await adapter.read.latestRoundData();

    console.log(`  ${desc} | decimals=${decimals}`);
    console.log(`  price: $${Number(answer) / 1e8} (raw: ${answer})`);
    console.log(`  roundId=${roundId} answeredInRound=${answeredInRound}`);
    console.log(`  updatedAt: ${updatedAt} (${new Date(Number(updatedAt) * 1000).toISOString()})`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
