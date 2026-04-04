import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";

/**
 * Deploy Solana State SDK contracts to monti_spl devnet.
 *
 * Deploys: JupiterSwap, DriftFactory, KaminoLending, KaminoVault, DeFiRouter
 *
 * Usage:
 *   npx hardhat run scripts/defi/deploy.ts --network monti_spl
 */

async function main() {
    const { viem, networkName } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) {
        throw new Error("No deployer wallet. Set MONTI_SPL_PRIVATE_KEY via env or: npx hardhat keystore set MONTI_SPL_PRIVATE_KEY --dev");
    }

    const publicClient = await viem.getPublicClient();
    const balance = await publicClient.getBalance({ address: deployer.account.address });
    console.log("Deployer:", deployer.account.address);
    console.log("Balance:", balance.toString());
    console.log("Network:", networkName);
    console.log();

    const CPI_PROGRAM = "0xFF00000000000000000000000000000000000008" as `0x${string}`;

    // ─── JupiterSwap ───
    console.log("Deploying JupiterSwap...");
    const jupiterSwap = await viem.deployContract("JupiterSwap", [CPI_PROGRAM]);
    console.log("  JupiterSwap:", jupiterSwap.address);

    // ─── DriftFactory ───
    console.log("Deploying DriftFactory...");
    const driftFactory = await viem.deployContract("DriftFactory", [CPI_PROGRAM]);
    console.log("  DriftFactory:", driftFactory.address);

    // ─── KaminoLending ───
    console.log("Deploying KaminoLending...");
    const kaminoLending = await viem.deployContract("KaminoLending", [CPI_PROGRAM]);
    console.log("  KaminoLending:", kaminoLending.address);

    // ─── KaminoVault ───
    console.log("Deploying KaminoVault...");
    const kaminoVault = await viem.deployContract("KaminoVault", [CPI_PROGRAM]);
    console.log("  KaminoVault:", kaminoVault.address);

    // ─── DeFiRouter ───
    console.log("Deploying DeFiRouter...");
    const defiRouter = await viem.deployContract("DeFiRouter", [CPI_PROGRAM]);
    console.log("  DeFiRouter:", defiRouter.address);

    // ─── Save deployments ───
    const deploymentsDir = path.resolve(process.cwd(), "deployments");
    fs.mkdirSync(deploymentsDir, { recursive: true });
    const filePath = path.resolve(deploymentsDir, `${networkName}.json`);
    let content: any = {};
    if (fs.existsSync(filePath)) {
        content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    content.SolanaStateSDK = {
        JupiterSwap: jupiterSwap.address,
        DriftFactory: driftFactory.address,
        KaminoLending: kaminoLending.address,
        KaminoVault: kaminoVault.address,
        DeFiRouter: defiRouter.address,
        cpiProgram: CPI_PROGRAM,
        deployedAt: new Date().toISOString(),
    };

    fs.writeFileSync(filePath, JSON.stringify(content, null, 2) + "\n", "utf8");
    console.log("\nDeployment saved to:", filePath);

    // ─── Verify DriftFactory ───
    console.log("\n=== Verification ===");
    const storedCpi = await driftFactory.read.cpi_program();
    console.log("DriftFactory.cpi_program:", storedCpi);
    console.log("Match:", storedCpi.toLowerCase() === CPI_PROGRAM.toLowerCase());

    console.log("\nAll contracts deployed successfully.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
