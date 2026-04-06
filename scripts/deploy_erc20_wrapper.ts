/**
 * Deploy an SPL_ERC20 wrapper for the wrapped Sepolia-WETH mint.
 * Usage: npx hardhat run scripts/deploy_erc20_wrapper.ts --network monti_spl
 */
import hardhat from "hardhat";

const CPI_PRECOMPILE = "0xFF00000000000000000000000000000000000008";

// Wrapped Sepolia-WETH mint (6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs)
const WRAPPED_WETH_MINT = "0x4de5b3fa1e6c00708f7ff480e2186357da3bc7110c576e9364da84c4c77ad904";

async function main() {
    const { viem } = await hardhat.network.connect();
    const [deployer] = await viem.getWalletClients();
    if (!deployer?.account) throw new Error("No deployer wallet");

    const publicClient = await viem.getPublicClient();
    console.log("Deployer:", deployer.account.address);

    console.log("Deploying SPL_ERC20 wrapper for wrapped Sepolia-WETH...");
    console.log("  Mint:", WRAPPED_WETH_MINT);
    console.log("  CPI precompile:", CPI_PRECOMPILE);

    const wrapper = await viem.deployContract("contracts/erc20spl/erc20spl.sol:SPL_ERC20", [
        WRAPPED_WETH_MINT,
        CPI_PRECOMPILE,
    ]);

    console.log("\nSPL_ERC20 deployed to:", wrapper.address);

    // Verify it works
    const decimals = await wrapper.read.decimals();
    const mintId = await wrapper.read.mint_id();
    const balance = await wrapper.read.balanceOf([deployer.account.address]);

    console.log("\nWrapper info:");
    console.log("  Decimals:", decimals);
    console.log("  Mint ID:", mintId);
    console.log("  Your balance:", balance.toString(), `(${Number(balance) / 10 ** Number(decimals)} WETH)`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
