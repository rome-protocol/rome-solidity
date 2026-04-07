import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";

/**
 * Local Rome stack setup script for rome-solidity testing.
 *
 * Prerequisites:
 *   1. Local Rome stack running (rome-setup/deploy/start-local.sh)
 *   2. LOCAL_PRIVATE_KEY set in dev keystore:
 *      npx hardhat keystore set LOCAL_PRIVATE_KEY --dev
 *      → ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
 *
 * What this does:
 *   1. Deploys MeteoraDAMMv1Factory + registers the pre-seeded SOL/USDC pool
 *   2. Deploys Oracle Gateway V2 (PythPullAdapter, SwitchboardV3Adapter, Factory, BatchReader)
 *   3. Creates Pyth Pull feed adapters for pre-seeded accounts (BTC, USDC, USDT, WETH)
 *   4. Saves everything to deployments/local.json
 *
 * Usage:
 *   npx hardhat run scripts/setup-local.ts --network local
 */

// Pre-seeded Meteora pool from rome-evm-private/ci/dump (mainnet snapshot)
// Base58: 5yuefgbJJpmFNK2iiYbLSpv1aZXq7F9AUKkZKErTYCvs
const POOL_PUBKEY: `0x${string}` =
    "0x4a02cdcd4da84ccd595ceff987b1738f19ee8d39afd64c91c6c123c47db61b18";

// Meteora program IDs (base58-decoded)
const PROG_DYNAMIC_AMM: `0x${string}` =
    "0xccf802d4cccc84d7fb21b5f73b49d81a16c5b4c88ee32394e1c91d3588cc4080"; // Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB
const PROG_DYNAMIC_VAULT: `0x${string}` =
    "0x0fbfe8846d685cbdc62cca7e04c7e8f68dcc313ab31277e2e0112a2ec0e052e5"; // 24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi
const CPI_ADDRESS: `0x${string}` = "0xFF00000000000000000000000000000000000008";

// Oracle program IDs
const PYTH_RECEIVER_PROGRAM_ID: `0x${string}` =
    "0x0cb7fabb52f7a648bb5b317d9a018b9057cb024774fafe01e6c4df98cc385881"; // rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ
const SWITCHBOARD_PROGRAM_ID: `0x${string}` =
    "0x068851c68c6832f02fa581b1bf491b77ca41776ba2b988b5a6faba8ee3a2ec90"; // SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f

// Pre-seeded Pyth feed accounts from rome-evm-private/ci/dump (mainnet snapshots)
const PYTH_FEEDS: { pair: string; pubkey: `0x${string}`; base58: string }[] = [
    {
        pair: "BTC / USD",
        pubkey: "0x35a70c11162fbf5a0e7f7d2f96e19f97b02246a15687ee672794897448e658de",
        base58: "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo",
    },
    {
        pair: "USDC / USD",
        pubkey: "0xbe939a8309f56407187fff30ac54b169498be99f6d8e1bfd4244680cd4f7d1e2",
        base58: "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX",
    },
    {
        pair: "USDT / USD",
        pubkey: "0x0436b7dea1e6d6556d85e7981663cccef16234d63541369a0bceaddb5a60e748",
        base58: "HT2PLQBcG5EiCcNSaMHAjSgd9F98ecpATbk4Sk5oYuM",
    },
    {
        pair: "WETH / USD",
        pubkey: "0x33562d75856b3d55ce3206ad38f50b8bf4e8c0dbd9cfa632f7904e1b105783f6",
        base58: "4TQ1VVWkrYUvyQ6hMmjepwr7swvqsyvLi75BiJi13Tf3",
    },
];

// 10 years in seconds — snapshot data is static, so staleness checks must be disabled
const LOCAL_MAX_STALENESS = 315_360_000n;

async function main() {
    const { viem, networkName } = await hardhat.network.connect();

    if (networkName !== "local") {
        throw new Error(`This script is only for the 'local' network (got: ${networkName})`);
    }

    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet found. Set LOCAL_PRIVATE_KEY in dev keystore.");
    }

    const publicClient = await viem.getPublicClient();
    const balance = await publicClient.getBalance({ address: deployer.account.address });

    console.log("=== Rome Solidity Local Setup ===");
    console.log("Deployer:", deployer.account.address);
    console.log("Balance:", balance.toString());
    console.log();

    const deployments: Record<string, any> = {};

    // ─── 1. Meteora DAMMv1 Factory ───
    console.log("=== 1/4 Deploying MeteoraDAMMv1Factory ===");
    const factory = await viem.deployContract("MeteoraDAMMv1Factory", [
        PROG_DYNAMIC_VAULT,
        PROG_DYNAMIC_AMM,
        CPI_ADDRESS,
    ]);
    console.log("  Factory:", factory.address);
    deployments.MeteoraDAMMv1Factory = { address: factory.address };

    // ─── 2. Register pre-seeded pool ───
    console.log("\n=== 2/4 Registering pre-seeded Meteora pool ===");
    console.log("  Pool pubkey:", POOL_PUBKEY);

    const addPoolTx = await factory.write.addPool([POOL_PUBKEY], {
        account: deployer.account,
    });
    const addPoolReceipt = await publicClient.waitForTransactionReceipt({ hash: addPoolTx });
    console.log("  Status:", addPoolReceipt.status);

    const poolCount = await factory.read.allPoolsLength();
    const poolAddress = await factory.read.allPools([poolCount - 1n]);
    console.log("  Pool EVM address:", poolAddress);

    deployments.MeteoraDAMMv1Pools = [
        {
            pubkey: POOL_PUBKEY,
            address: poolAddress,
            txHash: addPoolTx,
            blockNumber: addPoolReceipt.blockNumber.toString(),
        },
    ];

    // ─── 3. Oracle Gateway V2 ───
    console.log("\n=== 3/4 Deploying Oracle Gateway V2 ===");

    const pythImpl = await viem.deployContract("PythPullAdapter", []);
    console.log("  PythPullAdapter impl:", pythImpl.address);

    const sbImpl = await viem.deployContract("SwitchboardV3Adapter", []);
    console.log("  SwitchboardV3Adapter impl:", sbImpl.address);

    const oracleFactory = await viem.deployContract("OracleAdapterFactory", [
        pythImpl.address,
        sbImpl.address,
        PYTH_RECEIVER_PROGRAM_ID,
        SWITCHBOARD_PROGRAM_ID,
        LOCAL_MAX_STALENESS,
    ]);
    console.log("  OracleAdapterFactory:", oracleFactory.address);

    const batchReader = await viem.deployContract("BatchReader", []);
    console.log("  BatchReader:", batchReader.address);

    deployments.OracleGatewayV2 = {
        PythPullAdapter: { address: pythImpl.address, type: "implementation" },
        SwitchboardV3Adapter: { address: sbImpl.address, type: "implementation" },
        OracleAdapterFactory: {
            address: oracleFactory.address,
            pythPriceFeedProgramId: PYTH_RECEIVER_PROGRAM_ID,
            switchboardProgramId: SWITCHBOARD_PROGRAM_ID,
            defaultMaxStaleness: Number(LOCAL_MAX_STALENESS),
        },
        BatchReader: { address: batchReader.address },
        deployedAt: new Date().toISOString(),
    };

    // ─── 4. Create Pyth feeds ───
    console.log("\n=== 4/4 Creating Pyth Pull feed adapters ===");
    const feeds: any[] = [];

    for (const feed of PYTH_FEEDS) {
        process.stdout.write(`  ${feed.pair} (${feed.base58})... `);
        try {
            const txHash = await oracleFactory.write.createPythFeed(
                [feed.pubkey, feed.pair, LOCAL_MAX_STALENESS],
                { account: deployer.account },
            );
            await publicClient.waitForTransactionReceipt({ hash: txHash });
            const adapterAddr = await oracleFactory.read.pythAdapters([feed.pubkey]);
            console.log(adapterAddr);
            feeds.push({
                pair: feed.pair,
                pythAccountBase58: feed.base58,
                pythAccountBytes32: feed.pubkey,
                adapter: adapterAddr,
            });
        } catch (e: any) {
            const reason = e.cause?.reason ?? e.message?.slice(0, 80);
            console.log(`FAILED — ${reason}`);
            feeds.push({
                pair: feed.pair,
                pythAccountBase58: feed.base58,
                pythAccountBytes32: feed.pubkey,
                adapter: null,
                error: reason,
            });
        }
    }

    deployments.OracleGatewayV2.feeds = feeds;

    // ─── Save deployments ───
    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    fs.mkdirSync(deploymentsDir, { recursive: true });
    const filePath = path.resolve(deploymentsDir, "local.json");
    fs.writeFileSync(filePath, JSON.stringify(deployments, null, 2) + "\n", "utf8");

    // ─── Summary ───
    const successFeeds = feeds.filter((f) => f.adapter);
    const failedFeeds = feeds.filter((f) => !f.adapter);

    console.log("\n=== Setup Complete ===");
    console.log(`Deployments saved to: ${filePath}`);
    console.log(`Meteora: factory + 1 pool`);
    console.log(`Oracle: ${successFeeds.length}/${feeds.length} feeds created`);
    if (failedFeeds.length > 0) {
        console.log(`Failed feeds: ${failedFeeds.map((f) => f.pair).join(", ")}`);
    }
    console.log("\nRun tests:");
    console.log("  npx hardhat test tests/damm_v1_pool.integration.ts --network local");
    console.log("  npx hardhat test tests/oracle/ # parser unit tests (no network needed)");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
