import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";

/**
 * Deploy TokenRegistry and ERC20SPLFactory to the target network.
 *
 * Usage:
 *   npx hardhat run scripts/deploy_token_registry.ts --network monti_spl
 */

const CPI_PROGRAM = "0xFF00000000000000000000000000000000000008";

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

    // ─── Step 1: Deploy ERC20SPLFactory ───
    console.log("\nDeploying ERC20SPLFactory...");
    const factory = await viem.deployContract("ERC20SPLFactory", [CPI_PROGRAM]);
    console.log("ERC20SPLFactory deployed to:", factory.address);

    // ─── Step 2: Deploy TokenRegistry ───
    console.log("\nDeploying TokenRegistry...");
    const registry = await viem.deployContract("TokenRegistry", [factory.address]);
    console.log("TokenRegistry deployed to:", registry.address);

    // Verify state
    const owner = await registry.read.owner();
    const factoryAddr = await registry.read.factory();
    console.log("Registry owner:", owner);
    console.log("Registry factory:", factoryAddr);
    console.log("Token count:", (await registry.read.tokenCount()).toString());

    // ─── Save deployment ───
    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    fs.mkdirSync(deploymentsDir, { recursive: true });
    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);

    let content: Record<string, any> = {};
    if (fs.existsSync(filePath)) {
        content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    content.ERC20SPLFactory = {
        address: factory.address,
    };
    content.TokenRegistry = {
        address: registry.address,
        owner: owner,
    };

    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf8");
    console.log("\nDeployment saved to:", filePath);
    console.log("\nDone!");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
