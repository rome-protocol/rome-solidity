import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";

async function main() {
    const { viem, networkName } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet found. Configure a funded account for this network.");
    }

    const publicClient = await viem.getPublicClient();

    console.log("Deploying RomeWormholeBridge with account:", deployer.account.address);
    console.log(
        "Account balance:",
        (await publicClient.getBalance({ address: deployer.account.address })).toString(),
    );

    const bridge = await viem.deployContract("RomeWormholeBridge", []);
    console.log("RomeWormholeBridge deployed to:", bridge.address);

    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    fs.mkdirSync(deploymentsDir, { recursive: true });

    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(filePath)) {
        existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    existing["RomeWormholeBridge"] = {
        address: bridge.address,
    };

    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", "utf8");
    console.log("Saved deployment to:", filePath);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
