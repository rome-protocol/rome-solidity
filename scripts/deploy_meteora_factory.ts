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
    const progDynamicAmm = "0xccf802d4cccc84d7fb21b5f73b49d81a16c5b4c88ee32394e1c91d3588cc4080"; // Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB
    const progDynamicVault = "0x0fbfe8846d685cbdc62cca7e04c7e8f68dcc313ab31277e2e0112a2ec0e052e5"; // 24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi
    const cpiAddress = "0xFF00000000000000000000000000000000000008"; // Precompile address for CPI

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


    const factoryImpl = await viem.deployContract("MeteoraDAMMv1Factory", [progDynamicVault, progDynamicAmm, cpiAddress]);
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
