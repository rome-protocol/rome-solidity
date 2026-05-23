import hardhat from "hardhat";
import { isAddress, isHex } from "viem";
import { readDeployments, writeDeployments } from "../lib/deployments.js";

// Deploy SPL_ERC20_cached against an existing mint.
//
// Required inputs:
//   - WRAPPER_MINT_ID env var (bytes32 hex) — the Solana mint pubkey
//     this wrapper will sit on top of. Read from registry per chain.
//   - HARDHAT_NETWORK env var (default "hadrian")
//   - ERC20Users contract must already be deployed on the target
//     network (read from deployments/<network>.json).
//
// Optional inputs:
//   - WRAPPER_NAME / WRAPPER_SYMBOL env vars (defaults below)
//
// Writes the deployed address to deployments/<network>.json under
// the key "SPL_ERC20_cached".

async function main() {
    const networkName = process.env.HARDHAT_NETWORK ?? "hadrian";
    const deployments = readDeployments(networkName);

    const usersAddress = deployments.ERC20Users?.address;
    if (!usersAddress || !isAddress(usersAddress)) {
        throw new Error(
            `ERC20Users not deployed on ${networkName}. ` +
            `Run \`npx hardhat run scripts/bridge/deploy.ts --network ${networkName}\` first.`,
        );
    }

    const mintId = process.env.WRAPPER_MINT_ID;
    if (!mintId || !isHex(mintId) || mintId.length !== 66) {
        throw new Error(
            "WRAPPER_MINT_ID env var must be set to a 32-byte hex (0x + 64 chars).",
        );
    }

    const cpiProgram = "0xFF00000000000000000000000000000000000008";
    const wrapperName = process.env.WRAPPER_NAME ?? "Cached USDC";
    const wrapperSymbol = process.env.WRAPPER_SYMBOL ?? "wUSDCc";

    const { viem } = await hardhat.network.connect();
    const deployed = await viem.deployContract("SPL_ERC20_cached", [
        mintId,
        cpiProgram,
        wrapperName,
        wrapperSymbol,
        usersAddress,
    ]);

    console.log(`SPL_ERC20_cached deployed at ${deployed.address}`);
    console.log(`  mint:   ${mintId}`);
    console.log(`  users:  ${usersAddress}`);
    console.log(`  name:   ${wrapperName}`);
    console.log(`  symbol: ${wrapperSymbol}`);

    const all = readDeployments(networkName);
    all.SPL_ERC20_cached = {
        address: deployed.address,
        mint: mintId,
        name: wrapperName,
        symbol: wrapperSymbol,
    };
    writeDeployments(networkName, all);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
