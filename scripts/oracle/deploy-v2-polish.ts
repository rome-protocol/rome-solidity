import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";

/**
 * Coordinated redeploy of the polished Oracle Gateway V2 stack on monti_spl.
 *
 * Deploys:
 *   1. New PythPullAdapter implementation (with staleness guards + metadata())
 *   2. New SwitchboardV3Adapter implementation (with staleness guards + metadata())
 *   3. New OracleAdapterFactory wired to the new implementations
 *   4. New BatchReader (with getFeedHealth)
 *
 * Writes the new addresses under `OracleGatewayV2Polished` in
 * `deployments/<network>.json` and preserves the legacy `OracleGatewayV2`
 * block for reference.
 *
 * Does NOT seed feeds — run `deploy-seed-feeds.ts` next.
 *
 * Usage:
 *   npx hardhat run scripts/oracle/deploy-v2-polish.ts --network monti_spl
 *
 * Override program IDs / staleness via env vars if needed:
 *   PYTH_PRICE_FEED_PROGRAM_ID=0x...
 *   SWITCHBOARD_PROGRAM_ID=0x...
 *   DEFAULT_MAX_STALENESS=60
 */

// Pyth Solana Receiver program: rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ
// PriceFeedAccount PDAs are owned by this program on-chain.
const DEFAULT_PYTH_PRICE_FEED_PROGRAM_ID =
    "0x0cb7fabb52f7a648bb5b317d9a018b9057cb024774fafe01e6c4df98cc385881";

// Switchboard V3 program: SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f
const DEFAULT_SWITCHBOARD_PROGRAM_ID =
    "0x068851c68c6832f02fa581b1bf491b77ca41776ba2b988b5a6faba8ee3a2ec90";

const DEFAULT_MAX_STALENESS_SECONDS = 60;

async function main() {
    const pythProgramId =
        process.env.PYTH_PRICE_FEED_PROGRAM_ID ?? DEFAULT_PYTH_PRICE_FEED_PROGRAM_ID;
    const switchboardProgramId =
        process.env.SWITCHBOARD_PROGRAM_ID ?? DEFAULT_SWITCHBOARD_PROGRAM_ID;
    const defaultMaxStaleness = Number(
        process.env.DEFAULT_MAX_STALENESS ?? String(DEFAULT_MAX_STALENESS_SECONDS),
    );

    const { viem, networkName } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error(
            "No deployer wallet found. Configure a funded account for this network.",
        );
    }

    const publicClient = await viem.getPublicClient();

    console.log("=== Oracle Gateway V2 — Polished Redeploy ===");
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
    console.log("   PythPullAdapter impl:      ", pythImpl.address);

    // 2. Deploy SwitchboardV3Adapter implementation
    console.log("2/4 Deploying SwitchboardV3Adapter implementation...");
    const sbImpl = await viem.deployContract("SwitchboardV3Adapter", []);
    console.log("   SwitchboardV3Adapter impl: ", sbImpl.address);

    // 3. Deploy OracleAdapterFactory wired to the new implementations
    console.log("3/4 Deploying OracleAdapterFactory...");
    const factory = await viem.deployContract("OracleAdapterFactory", [
        pythImpl.address,
        sbImpl.address,
        pythProgramId as `0x${string}`,
        switchboardProgramId as `0x${string}`,
        BigInt(defaultMaxStaleness),
    ]);
    console.log("   OracleAdapterFactory:      ", factory.address);

    // 4. Deploy BatchReader
    console.log("4/4 Deploying BatchReader...");
    const batchReader = await viem.deployContract("BatchReader", []);
    console.log("   BatchReader:               ", batchReader.address);

    console.log();
    console.log("=== Deployment Complete ===");

    // Save deployment artifacts — add polished block alongside legacy one.
    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    fs.mkdirSync(deploymentsDir, { recursive: true });

    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);
    let content: any = {};
    if (fs.existsSync(filePath)) {
        content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    // Preserve the legacy OracleGatewayV2 block untouched — we only add a
    // sibling OracleGatewayV2Polished entry here.
    content.OracleGatewayV2Polished = {
        deployedAt: new Date().toISOString(),
        defaultMaxStaleness,
        pythReceiverProgramId: pythProgramId,
        switchboardProgramId,
        PythPullAdapterImpl: pythImpl.address,
        SwitchboardV3AdapterImpl: sbImpl.address,
        OracleAdapterFactory: factory.address,
        BatchReader: batchReader.address,
        feeds: { pyth: [], switchboard: [] },
    };

    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf8");
    console.log("Wrote addresses to:", filePath);
    console.log();
    console.log("Next step: run deploy-seed-feeds.ts to seed Pyth/Switchboard feeds.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
