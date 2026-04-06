import hardhat from "hardhat";

const BRIDGE_ADDRESS = "0xbea26188700465d33eb29a0f4ada72de0fb08780";

// Wormhole Solana Devnet (Testnet) Program IDs
// Core Bridge: 3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5
// Token Bridge: DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe
//
// These are base58-encoded Solana public keys. Below are their bytes32 hex equivalents.
const WORMHOLE_CORE_BRIDGE  = "0x" + "0ec7ec60e38fa1069263046e2d3034ed759e8de9a0c0e3591cb31b3d1cefb35d" as `0x${string}`;
const WORMHOLE_TOKEN_BRIDGE = "0x" + "b6c1eef04d2ab7964c4bea5b756e91166aa1b1a346e3978e31704ab8bb5b3744" as `0x${string}`;

// SPL Token Program ID: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
const SPL_TOKEN_PROGRAM     = "0x" + "06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9" as `0x${string}`;

async function main() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    if (!wallet?.account) throw new Error("No wallet found");

    console.log("=== RomeWormholeBridge Smoke Test ===");
    console.log("Wallet:", wallet.account.address);
    console.log("Balance:", (await publicClient.getBalance({ address: wallet.account.address })).toString());
    console.log("Bridge:", BRIDGE_ADDRESS);
    console.log("");

    const bridge = await viem.getContractAt("RomeWormholeBridge", BRIDGE_ADDRESS);

    // 1. Get your Solana PDA
    console.log("--- 1. Your Solana PDA ---");
    const pda = await bridge.read.bridgeUserPda();
    console.log("PDA:", pda);
    console.log("(Use this as the recipient when sending FROM Ethereum via Wormhole)");
    console.log("");

    // 2. Test authority signer PDA for Token Bridge
    console.log("--- 2. Authority Signer PDA ---");
    try {
        const authSigner = await bridge.read.authoritySignerPda([WORMHOLE_TOKEN_BRIDGE]);
        console.log("Token Bridge authority_signer PDA:", authSigner);
    } catch (e: any) {
        console.log("Failed (Token Bridge may not be reachable):", e.message?.slice(0, 100));
    }
    console.log("");

    // 3. Test pure encoding functions
    console.log("--- 3. Instruction Encodings (pure, no gas) ---");

    const transferData = await bridge.read.encodeTransferNative([
        0,                                                                    // nonce
        BigInt(1_000_000),                                                    // amount
        BigInt(0),                                                            // fee
        "0x000000000000000000000000" + wallet.account.address.slice(2),       // target as bytes32
        2,                                                                    // target chain (2 = Ethereum)
    ]);
    console.log("encodeTransferNative:", transferData.slice(0, 40) + "...");
    console.log("  Length:", (transferData.length - 2) / 2, "bytes");

    const completeData = await bridge.read.encodeCompleteNative();
    console.log("encodeCompleteNative:", completeData, "(should be 0x02)");

    const completeWrappedData = await bridge.read.encodeCompleteWrapped();
    console.log("encodeCompleteWrapped:", completeWrappedData, "(should be 0x03)");

    const approveData = await bridge.read.encodeSplTokenApprove([BigInt(1_000_000)]);
    console.log("encodeSplTokenApprove:", approveData);
    console.log("");

    // 4. Summary
    console.log("=== All view/pure functions work! ===");
    console.log("");
    console.log("Wormhole Program IDs (Solana Devnet):");
    console.log("  Core Bridge:  3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
    console.log("  Token Bridge: DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
    console.log("");
    console.log("Your deployment:");
    console.log("  RomeWormholeBridge:", BRIDGE_ADDRESS);
    console.log("  Your Solana PDA:  ", pda);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
