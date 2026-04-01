import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { toHex } from "viem";

/**
 * Deploy PythAggregatorFactory to monti_spl and create a feed adapter
 * for a real Pyth devnet price account.
 */

async function main() {
    const { viem, networkName } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet. Set MONTI_SPL_PRIVATE_KEY.");
    }

    const publicClient = await viem.getPublicClient();
    const balance = await publicClient.getBalance({ address: deployer.account.address });
    console.log("Deployer:", deployer.account.address);
    console.log("Balance:", balance.toString());

    // ─── Step 1: Convert Pyth devnet program ID to bytes32 ───
    // gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s
    // We use the SystemProgram precompile to convert base58 → bytes32
    const systemProgram = await viem.getContractAt(
        "ISystemProgram",
        "0xfF00000000000000000000000000000000000007",
    );

    const pythProgramId = await systemProgram.read.base58_to_bytes32([
        toHex(Buffer.from("gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s")),
    ]);
    console.log("Pyth Program ID (bytes32):", pythProgramId);

    // ─── Step 2: Deploy PythAggregatorFactory ───
    console.log("\nDeploying PythAggregatorFactory...");
    const factory = await viem.deployContract("PythAggregatorFactory", [pythProgramId]);
    console.log("Factory deployed to:", factory.address);

    // Verify factory state
    const storedProgramId = await factory.read.pythProgramId();
    console.log("Factory pythProgramId:", storedProgramId);
    console.log("Matches:", storedProgramId === pythProgramId);

    const totalBefore = await factory.read.totalFeeds();
    console.log("Total feeds before:", totalBefore.toString());

    // ─── Step 3: Find a Pyth devnet price feed ───
    // Pyth devnet BTC/USD price account: GVXRSBjFk6e6J3NbVPXbvDBth43bQuVBMi5Bia4aDwXF
    // Pyth devnet SOL/USD price account: J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix
    // Let's use SOL/USD since it's commonly active on devnet
    const solUsdFeedBase58 = "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix";
    const solUsdPubkey = await systemProgram.read.base58_to_bytes32([
        toHex(Buffer.from(solUsdFeedBase58)),
    ]);
    console.log("\nSOL/USD Pyth pubkey (bytes32):", solUsdPubkey);

    // ─── Step 4: Create feed adapter ───
    console.log("\nCreating SOL/USD feed adapter...");
    const txHash = await factory.write.createFeed([solUsdPubkey, "SOL/USD"]);
    console.log("createFeed tx:", txHash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("Status:", receipt.status);

    const adapterAddress = await factory.read.feedAdapters([solUsdPubkey]);
    console.log("SOL/USD adapter deployed to:", adapterAddress);

    const totalAfter = await factory.read.totalFeeds();
    console.log("Total feeds after:", totalAfter.toString());

    // ─── Step 5: Read price via the adapter ───
    const adapter = await viem.getContractAt(
        "PythAggregatorV3",
        adapterAddress as `0x${string}`,
    );

    console.log("\n=== SOL/USD Adapter ===");
    console.log("Description:", await adapter.read.description());
    console.log("Decimals:", await adapter.read.decimals());
    console.log("Version:", (await adapter.read.version()).toString());

    const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        await adapter.read.latestRoundData();

    console.log("\nlatestRoundData():");
    console.log("  roundId:", roundId.toString());
    console.log("  answer:", answer.toString(), `($${Number(answer) / 1e8})`);
    console.log("  startedAt:", startedAt.toString(), `(${new Date(Number(startedAt) * 1000).toISOString()})`);
    console.log("  updatedAt:", updatedAt.toString(), `(${new Date(Number(updatedAt) * 1000).toISOString()})`);
    console.log("  answeredInRound:", answeredInRound.toString());

    const latestAnswer = await adapter.read.latestAnswer();
    console.log("\nlatestAnswer():", latestAnswer.toString(), `($${Number(latestAnswer) / 1e8})`);

    const latestTs = await adapter.read.latestTimestamp();
    console.log("latestTimestamp():", latestTs.toString());

    const latestRound = await adapter.read.latestRound();
    console.log("latestRound():", latestRound.toString());

    // ─── Step 6: Try BTC/USD too ───
    const btcUsdFeedBase58 = "HovQMDrbAgAYPCmHVSrezcSmkMtXSSUsLDFANExrZh2J";
    const btcUsdPubkey = await systemProgram.read.base58_to_bytes32([
        toHex(Buffer.from(btcUsdFeedBase58)),
    ]);
    console.log("\n\nCreating BTC/USD feed adapter...");
    const btcTxHash = await factory.write.createFeed([btcUsdPubkey, "BTC/USD"]);
    const btcReceipt = await publicClient.waitForTransactionReceipt({ hash: btcTxHash });
    console.log("Status:", btcReceipt.status);

    const btcAdapterAddress = await factory.read.feedAdapters([btcUsdPubkey]);
    const btcAdapter = await viem.getContractAt(
        "PythAggregatorV3",
        btcAdapterAddress as `0x${string}`,
    );

    console.log("\n=== BTC/USD Adapter ===");
    console.log("Description:", await btcAdapter.read.description());

    const [, btcAnswer, , btcUpdatedAt] = await btcAdapter.read.latestRoundData();
    console.log("Price:", btcAnswer.toString(), `($${Number(btcAnswer) / 1e8})`);
    console.log("Updated:", new Date(Number(btcUpdatedAt) * 1000).toISOString());

    // ─── Step 7: Verify duplicate prevention ───
    console.log("\n\nVerifying duplicate feed prevention...");
    try {
        await factory.write.createFeed([solUsdPubkey, "SOL/USD duplicate"]);
        console.log("ERROR: Should have reverted!");
    } catch (e: any) {
        console.log("Correctly reverted on duplicate:", e.message?.slice(0, 80));
    }

    // ─── Step 8: Verify getRoundData reverts ───
    console.log("\nVerifying getRoundData reverts...");
    try {
        await adapter.read.getRoundData([1]);
        console.log("ERROR: Should have reverted!");
    } catch (e: any) {
        console.log("Correctly reverted:", e.message?.slice(0, 80));
    }

    // ─── Save deployment ───
    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);
    let content: any = {};
    if (fs.existsSync(filePath)) {
        content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    content.PythAggregatorFactory = {
        address: factory.address,
        pythProgramId: pythProgramId,
    };
    content.PythAggregatorFeeds = [
        {
            pair: "SOL/USD",
            pythAccount: solUsdPubkey,
            adapter: adapterAddress,
        },
        {
            pair: "BTC/USD",
            pythAccount: btcUsdPubkey,
            adapter: btcAdapterAddress,
        },
    ];

    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf8");
    console.log("\nDeployment saved to:", filePath);
    console.log("\n✓ All done!");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
