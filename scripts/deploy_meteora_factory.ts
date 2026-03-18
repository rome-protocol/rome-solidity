import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { type Abi, isAddress, encodeFunctionData } from "viem";

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

async function main() {
    const progDynamicAmm = "0xcbe5357484699af28489f7d3f863df8f04c10db8bf8f753ea7f2d79e6e09f4b0";
    const progDynamicVault = "0x1051efe75a2e47e09ee987cf6761dffaad9aca72a74206ded07e0773d5975e4c";

    const { viem, networkName } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet found. Configure a funded account for this network.");
    }

    const publicClient = await viem.getPublicClient();

    console.log("Deploying MeteoraDAMMv1Factory implementation with account:", deployer.account.address);
    console.log(
        "Account balance:",
        (await publicClient.getBalance({ address: deployer.account.address })).toString(),
    );


    const factoryImpl = await viem.deployContract("MeteoraDAMMv1Factory", [progDynamicVault, progDynamicAmm]);
    console.log("MeteoraDAMMv1Factory implementation deployed to:", factoryImpl.address);

    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    fs.mkdirSync(deploymentsDir, { recursive: true });

    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);
    const content = {
        MeteoraDAMMv1Factory: {
            address: factoryImpl.address,
        },
    };

    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf8");
    console.log("Saved deployment to:", filePath);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
