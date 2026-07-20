import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { getAddress, isAddress } from "viem";
import {
    deploySplErc20,
    deployWithdraw,
} from "./bridge/deploy.js";
import { SPL_MINTS_DEVNET } from "./bridge/constants.js";

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
 *   1. Deploys Oracle Gateway V2 (PythPullAdapter, SwitchboardV3Adapter, Factory, BatchReader)
 *   2. Creates Pyth Pull + Switchboard feed adapters for pre-seeded accounts
 *   3. Deploys the SPL-ERC20 wrappers + RomeBridgeWithdraw
 *   4. Saves everything to deployments/local.json
 *
 * Usage:
 *   npx hardhat run scripts/setup-local.ts --network local
 */

// Oracle program IDs
const PYTH_RECEIVER_PROGRAM_ID: `0x${string}` =
    "0x0cb7fabb52f7a648bb5b317d9a018b9057cb024774fafe01e6c4df98cc385881"; // rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ
const SWITCHBOARD_PROGRAM_ID: `0x${string}` =
    "0x068851c68c6832f02fa581b1bf491b77ca41776ba2b988b5a6faba8ee3a2ec90"; // SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f

// Pre-seeded Pyth feed accounts from the Rome EVM program (mainnet snapshots)
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

// Pre-seeded Switchboard aggregator accounts from the Rome EVM program (mainnet snapshots)
const SWITCHBOARD_FEEDS: { pair: string; pubkey: `0x${string}`; base58: string }[] = [
    {
        pair: "SOL / USD (Switchboard)",
        pubkey: "0xec81105112a257d61df4cf5f13ee0a1b019197c8c5343b4f2a7ec8846ae22c1a",
        base58: "GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR",
    },
];

// 10 years in seconds — snapshot data is static, so staleness checks must be disabled
const LOCAL_MAX_STALENESS = 315_360_000n;

function resolveAddress(value: string, name: string): `0x${string}` {
    if (!isAddress(value)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }

    return getAddress(value);
}

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

    // ─── 1. Oracle Gateway V2 ───
    console.log("=== 1/4 Deploying Oracle Gateway V2 ===");

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

    // ─── 2. Create Pyth feeds ───
    console.log("\n=== 2/4 Creating Pyth Pull feed adapters ===");
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

    // ─── 3. Create Switchboard feeds ───
    console.log("\n=== 3/4 Creating Switchboard feed adapters ===");
    const sbFeeds: any[] = [];

    for (const feed of SWITCHBOARD_FEEDS) {
        process.stdout.write(`  ${feed.pair} (${feed.base58})... `);
        try {
            const txHash = await oracleFactory.write.createSwitchboardFeed(
                [feed.pubkey, feed.pair, LOCAL_MAX_STALENESS],
                { account: deployer.account },
            );
            await publicClient.waitForTransactionReceipt({ hash: txHash });
            const adapterAddr = await oracleFactory.read.switchboardAdapters([feed.pubkey]);
            console.log(adapterAddr);
            sbFeeds.push({
                pair: feed.pair,
                aggregator: feed.base58,
                aggregatorBytes32: feed.pubkey,
                adapter: adapterAddr,
            });
        } catch (e: any) {
            const reason = e.cause?.reason ?? e.message?.slice(0, 80);
            console.log(`FAILED — ${reason}`);
            sbFeeds.push({
                pair: feed.pair,
                aggregator: feed.base58,
                aggregatorBytes32: feed.pubkey,
                adapter: null,
                error: reason,
            });
        }
    }

    deployments.OracleGatewayV2.switchboardFeeds = sbFeeds;

    // ─── 4. Bridge contracts ───
    console.log("\n=== 4/4 Deploying Rome Bridge contracts ===");

    // CPI precompile address — defined in contracts/interface.sol as 0xff..08.
    const cpiProgramAddress = "0xFF00000000000000000000000000000000000008" as `0x${string}`;

    // Local stack uses devnet mint set (rome-setup seeds Wormhole/CCTP devnet
    // programs alongside these mints).
    const usdcMint = SPL_MINTS_DEVNET.USDC_NATIVE;
    const wethMint = SPL_MINTS_DEVNET.WETH_WORMHOLE;

    const usdcWrapper = await deploySplErc20(
        "SPL_ERC20_USDC",
        "Wrapped USDC",
        "WUSDC",
        usdcMint,
        cpiProgramAddress,
    );
    deployments.SPL_ERC20_USDC = { address: usdcWrapper.address, mintId: usdcMint };

    const wethWrapper = await deploySplErc20(
        "SPL_ERC20_WETH",
        "Wrapped ETH",
        "WETH",
        wethMint,
        cpiProgramAddress,
    );
    deployments.SPL_ERC20_WETH = { address: wethWrapper.address, mintId: wethMint };

    try {
        await deployWithdraw(
            usdcWrapper.address,
            wethWrapper.address,
            usdcMint,
            wethMint,
        );
        deployments.RomeBridgeWithdraw = { address: "(see deployments/local.json)" };
    } catch (err) {
        console.warn(
            "Skipping RomeBridgeWithdraw deploy — PDA derivation failed:",
            (err as Error).message,
        );
    }

    // ─── Save deployments ───
    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    fs.mkdirSync(deploymentsDir, { recursive: true });
    const filePath = path.resolve(deploymentsDir, "local.json");
    fs.writeFileSync(filePath, JSON.stringify(deployments, null, 2) + "\n", "utf8");

    // ─── Summary ───
    const successFeeds = feeds.filter((f) => f.adapter);
    const failedFeeds = feeds.filter((f) => !f.adapter);
    const successSbFeeds = sbFeeds.filter((f: any) => f.adapter);
    const failedSbFeeds = sbFeeds.filter((f: any) => !f.adapter);

    console.log("\n=== Setup Complete ===");
    console.log(`Deployments saved to: ${filePath}`);
    console.log(`Pyth feeds: ${successFeeds.length}/${feeds.length} created`);
    console.log(`Switchboard feeds: ${successSbFeeds.length}/${sbFeeds.length} created`);
    console.log(`Bridge: WUSDC wrapper + WETH wrapper + RomeBridgeWithdraw`);
    const allFailed = [...failedFeeds, ...failedSbFeeds];
    if (allFailed.length > 0) {
        console.log(`Failed feeds: ${allFailed.map((f: any) => f.pair).join(", ")}`);
    }
    console.log("\nRun tests:");
    console.log("  npx hardhat test tests/oracle/ # parser unit tests (no network needed)");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
