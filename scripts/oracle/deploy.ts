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
 *   PYTH_RECEIVER_PROGRAM_ID=0x... SWITCHBOARD_PROGRAM_ID=0x... \
 *   npx hardhat run scripts/oracle/deploy.ts --network monti_spl
 */

async function main() {
    const pythReceiverProgramId = process.env.PYTH_RECEIVER_PROGRAM_ID;
    if (!pythReceiverProgramId) {
        throw new Error(
            "PYTH_RECEIVER_PROGRAM_ID env var required (bytes32 hex of Pyth Solana Receiver program)",
        );
    }

    const switchboardProgramId = process.env.SWITCHBOARD_PROGRAM_ID;
    if (!switchboardProgramId) {
        throw new Error(
            "SWITCHBOARD_PROGRAM_ID env var required (bytes32 hex of Switchboard V3 program)",
        );
    }

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
    console.log("Pyth Receiver Program ID:", pythReceiverProgramId);
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
        pythReceiverProgramId as `0x${string}`,
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
            pythReceiverProgramId,
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
