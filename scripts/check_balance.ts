/**
 * Check wrapped WETH balance on Rome EVM.
 * Usage: npx hardhat run scripts/check_balance.ts --network monti_spl
 */
import hardhat from "hardhat";

const CPI_PRECOMPILE = "0xFF00000000000000000000000000000000000008" as const;
const BRIDGE_ADDRESS = "0x79f34fa78651efa9d24ff8ac526cbd9753e8fc1f" as const;
const ATA_HEX = "0x2c3841a2ef51185c1696f78fe15e83aa55fe6bcbb843239e2cbe6ff19f59cebc" as `0x${string}`;

const accountInfoAbi = [{
    name: "account_info",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "pubkey", type: "bytes32" as const }],
    outputs: [
        { name: "lamports", type: "uint64" as const },
        { name: "owner", type: "bytes32" as const },
        { name: "is_signer", type: "bool" as const },
        { name: "is_writable", type: "bool" as const },
        { name: "executable", type: "bool" as const },
        { name: "data", type: "bytes" as const },
    ],
}] as const;

async function main() {
    const { viem } = await hardhat.network.connect();
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    if (!wallet?.account) throw new Error("No wallet");

    console.log("=== Rome EVM Wallet Balances ===");
    console.log("Wallet:", wallet.account.address);

    const bridge = await viem.getContractAt("RomeWormholeBridge", BRIDGE_ADDRESS);
    const pdaHex = await bridge.read.bridgeUserPda() as string;
    console.log("PDA:", pdaHex);

    // Native SOL balance on Rome EVM
    const ethBalance = await publicClient.getBalance({ address: wallet.account.address });
    console.log("\nNative SOL:", (Number(ethBalance) / 1e18).toFixed(6), "SOL");

    // Read SPL token account via CPI precompile
    const result = await publicClient.readContract({
        address: CPI_PRECOMPILE,
        abi: accountInfoAbi,
        functionName: "account_info",
        args: [ATA_HEX],
    });

    const [lamports, owner, , , , data] = result;
    const dataBytes = Buffer.from((data as string).slice(2), "hex");

    if (dataBytes.length >= 72) {
        const mint = "0x" + dataBytes.subarray(0, 32).toString("hex");
        const tokenOwner = "0x" + dataBytes.subarray(32, 64).toString("hex");
        const amount = dataBytes.readBigUInt64LE(64);

        console.log("\nWrapped Sepolia-WETH (SPL token):");
        console.log("  ATA:", ATA_HEX);
        console.log("  Mint:", mint);
        console.log("  Owner:", tokenOwner);
        console.log("  Balance:", amount.toString(), "raw");
        console.log("  Balance:", (Number(amount) / 1e8).toFixed(8), "WETH (8 decimals)");
    } else {
        console.log("\nNo token account data found at ATA.");
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
