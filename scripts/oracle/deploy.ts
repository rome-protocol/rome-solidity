import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";

/**
 * Oracle Gateway V2 deployment script.
 *
 * Deploys:
 *   1. PythPullAdapter implementation contract
 *   2. SwitchboardV3Adapter implementation contract
 *   3. OracleAdapterFactory (with both implementations)
 *   4. BatchReader
 *
 * Usage:
 *   npx hardhat run scripts/oracle/deploy.ts --network monti_spl
 *
 * Override program IDs via env vars if needed:
 *   PYTH_PRICE_FEED_PROGRAM_ID=0x...
 *   SWITCHBOARD_PROGRAM_ID=0x...
 *   DEFAULT_MAX_STALENESS=60
 */

// Pyth Price Feed program: pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT
const DEFAULT_PYTH_PRICE_FEED_PROGRAM_ID =
    "0x0c4aa0128e95d3e1622aa501c585a9eb07b37354c108ea0b791b456dc7eea336";

// Switchboard V3 program: SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f
const DEFAULT_SWITCHBOARD_PROGRAM_ID =
    "0x068851c68c6832f02fa581b1bf491b77ca41776ba2b988b5a6faba8ee3a2ec90";

async function main() {
    const pythProgramId =
        process.env.PYTH_PRICE_FEED_PROGRAM_ID ?? DEFAULT_PYTH_PRICE_FEED_PROGRAM_ID;
    const switchboardProgramId =
        process.env.SWITCHBOARD_PROGRAM_ID ?? DEFAULT_SWITCHBOARD_PROGRAM_ID;
    const defaultMaxStaleness = Number(process.env.DEFAULT_MAX_STALENESS ?? "60");

    const { viem, networkName } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error(
            "No deployer wallet found. Configure a funded account for this network.",
        );
    }

    const publicClient = await viem.getPublicClient();

    console.log("=== Oracle Gateway V2 Deployment ===");
    console.log("Deployer:", deployer.account.address);
    console.log(
        "Balance:",
        (await publicClient.getBalance({ address: deployer.account.address })).toString(),
    );
    console.log("Network:", networkName);
    console.log("Pyth Price Feed Program ID:", pythProgramId);
    console.log("Switchboard Program ID:", switchboardProgramId);
    console.log("Default Max Staleness:", defaultMaxStaleness, "seconds");
    console.log();

    // 1. Deploy PythPullAdapter implementation
    console.log("1/4 Deploying PythPullAdapter implementation...");
    const pythImpl = await viem.deployContract("PythPullAdapter", []);
    console.log("   PythPullAdapter:", pythImpl.address);

    // 2. Deploy SwitchboardV3Adapter implementation
    console.log("2/4 Deploying SwitchboardV3Adapter implementation...");
    const sbImpl = await viem.deployContract("SwitchboardV3Adapter", []);
    console.log("   SwitchboardV3Adapter:", sbImpl.address);

    // 3. Deploy OracleAdapterFactory
    console.log("3/4 Deploying OracleAdapterFactory...");
    const factory = await viem.deployContract("OracleAdapterFactory", [
        pythImpl.address,
        sbImpl.address,
        pythProgramId as `0x${string}`,
        switchboardProgramId as `0x${string}`,
        BigInt(defaultMaxStaleness),
    ]);
    console.log("   OracleAdapterFactory:", factory.address);

    // 4. Deploy BatchReader
    console.log("4/4 Deploying BatchReader...");
    const batchReader = await viem.deployContract("BatchReader", []);
    console.log("   BatchReader:", batchReader.address);

    console.log();
    console.log("=== Deployment Complete ===");

    // Save deployment artifacts
    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    fs.mkdirSync(deploymentsDir, { recursive: true });

    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);
    let content: any = {};
    if (fs.existsSync(filePath)) {
        content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    content.OracleGatewayV2 = {
        PythPullAdapter: { address: pythImpl.address, type: "implementation" },
        SwitchboardV3Adapter: { address: sbImpl.address, type: "implementation" },
        OracleAdapterFactory: {
            address: factory.address,
            pythPriceFeedProgramId: pythProgramId,
            switchboardProgramId,
            defaultMaxStaleness,
        },
        BatchReader: { address: batchReader.address },
        deployedAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf8");
    console.log("Saved deployment to:", filePath);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
