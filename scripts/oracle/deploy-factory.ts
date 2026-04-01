import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";

async function main() {
    const pythProgramId = process.env.PYTH_PROGRAM_ID;
    if (!pythProgramId) {
        throw new Error(
            "PYTH_PROGRAM_ID env var required (bytes32 hex of Pyth program pubkey)",
        );
    }

    const { viem, networkName } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error(
            "No deployer wallet found. Configure a funded account for this network.",
        );
    }

    const publicClient = await viem.getPublicClient();

    console.log("Deploying PythAggregatorFactory with account:", deployer.account.address);
    console.log(
        "Account balance:",
        (await publicClient.getBalance({ address: deployer.account.address })).toString(),
    );
    console.log("Pyth Program ID:", pythProgramId);

    const factory = await viem.deployContract("PythAggregatorFactory", [
        pythProgramId as `0x${string}`,
    ]);
    console.log("PythAggregatorFactory deployed to:", factory.address);

    // Save deployment
    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    fs.mkdirSync(deploymentsDir, { recursive: true });

    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);
    let content: any = {};
    if (fs.existsSync(filePath)) {
        content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    content.PythAggregatorFactory = {
        address: factory.address,
        pythProgramId,
    };

    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf8");
    console.log("Saved deployment to:", filePath);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
