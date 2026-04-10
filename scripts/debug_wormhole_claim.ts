/**
 * Debug the claimCompleteWrapped CPI call.
 * Usage: MONTI_SPL_PRIVATE_KEY=0x... npx hardhat run scripts/debug_wormhole_claim.ts --network monti_spl
 */
import hardhat from "hardhat";
import { PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram as SolanaSystemProgram } from "@solana/web3.js";
import {
    publicKeyToBytes32Hex,
    solanaAccountMetasToRome,
} from "@wormhole-foundation/sdk-solana";
import { utils as coreUtils } from "@wormhole-foundation/sdk-solana-core";
import {
    deriveTokenBridgeConfigKey,
    deriveMintAuthorityKey,
    deriveWrappedMintKey,
    deriveWrappedMetaKey,
    deriveEndpointKey,
} from "@wormhole-foundation/sdk-solana-tokenbridge";
import { encodeFunctionData } from "viem";

const TOKEN_BRIDGE = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const WORMHOLE_CORE = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
const SPL_TOKEN_PK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const BRIDGE_ADDRESS = "0xbea26188700465d33eb29a0f4ada72de0fb08780";

const CPI_PRECOMPILE = "0xFF00000000000000000000000000000000000008" as const;

function pkHex(pk: PublicKey): `0x${string}` {
    return `0x${Buffer.from(pk.toBytes()).toString("hex")}` as `0x${string}`;
}

function getAta(mint: PublicKey, owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), SPL_TOKEN_PK.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM,
    )[0];
}

async function main() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    const bridge = await viem.getContractAt("RomeWormholeBridge", BRIDGE_ADDRESS);

    console.log("Wallet:", wallet.account.address);

    // Get PDA
    const pdaHex = await bridge.read.bridgeUserPda() as `0x${string}`;
    const pda = new PublicKey(Buffer.from(pdaHex.slice(2), "hex"));
    console.log("PDA:", pda.toBase58(), "(hex:", pdaHex, ")");

    // Test encodeCompleteWrapped
    const ixData = await bridge.read.encodeCompleteWrapped();
    console.log("encodeCompleteWrapped():", ixData);

    // Build the accounts for completeWrapped (same as the main script)
    const tokenAddress = Buffer.from("000000000000000000000000eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c", "hex");
    const tokenChain = 10002;
    const emitterAddress = Buffer.from("000000000000000000000000db5492265f6038831e89f495670ff909ade94bd9", "hex");
    const emitterChain = 10002;
    const sequence = 343843n;
    const vaaHash = Buffer.from("0759cf88cbb5b1dd805238203bbe63ede5b56effc01d1bc31fd6dd69137e473c", "hex");

    const wrappedMint = deriveWrappedMintKey(TOKEN_BRIDGE, tokenChain, tokenAddress);
    const recipientAta = getAta(wrappedMint, pda);
    const postedVaaKey = coreUtils.derivePostedVaaKey(WORMHOLE_CORE, vaaHash);
    const claimKey = coreUtils.deriveClaimKey(TOKEN_BRIDGE, emitterAddress, emitterChain, sequence);
    const endpointKey = deriveEndpointKey(TOKEN_BRIDGE, emitterChain, emitterAddress);

    console.log("\nAccount addresses:");
    console.log("  payer (PDA):", pda.toBase58());
    console.log("  config:", deriveTokenBridgeConfigKey(TOKEN_BRIDGE).toBase58());
    console.log("  postedVaa:", postedVaaKey.toBase58());
    console.log("  claim:", claimKey.toBase58());
    console.log("  endpoint:", endpointKey.toBase58());
    console.log("  to (ATA):", recipientAta.toBase58());
    console.log("  wrappedMint:", wrappedMint.toBase58());
    console.log("  wrappedMeta:", deriveWrappedMetaKey(TOKEN_BRIDGE, wrappedMint).toBase58());
    console.log("  mintAuthority:", deriveMintAuthorityKey(TOKEN_BRIDGE).toBase58());

    // Try approach 1: Direct CPI invoke to Token Bridge (bypassing RomeWormholeBridge)
    console.log("\n--- Approach 1: Direct CPI invoke ---");
    const tokenBridgeHex = pkHex(TOKEN_BRIDGE);
    const accounts = [
        { pubkey: pdaHex, is_signer: true, is_writable: true },
        { pubkey: pkHex(deriveTokenBridgeConfigKey(TOKEN_BRIDGE)), is_signer: false, is_writable: false },
        { pubkey: pkHex(postedVaaKey), is_signer: false, is_writable: false },
        { pubkey: pkHex(claimKey), is_signer: false, is_writable: true },
        { pubkey: pkHex(endpointKey), is_signer: false, is_writable: false },
        { pubkey: pkHex(recipientAta), is_signer: false, is_writable: true },
        { pubkey: pkHex(recipientAta), is_signer: false, is_writable: true },
        { pubkey: pkHex(wrappedMint), is_signer: false, is_writable: true },
        { pubkey: pkHex(deriveWrappedMetaKey(TOKEN_BRIDGE, wrappedMint)), is_signer: false, is_writable: false },
        { pubkey: pkHex(deriveMintAuthorityKey(TOKEN_BRIDGE)), is_signer: false, is_writable: false },
        { pubkey: pkHex(SYSVAR_RENT_PUBKEY), is_signer: false, is_writable: false },
        { pubkey: pkHex(SolanaSystemProgram.programId), is_signer: false, is_writable: false },
        { pubkey: pkHex(SPL_TOKEN_PK), is_signer: false, is_writable: false },
        { pubkey: pkHex(WORMHOLE_CORE), is_signer: false, is_writable: false },
    ];

    const cpiAbi = [{
        name: "invoke",
        type: "function" as const,
        stateMutability: "nonpayable" as const,
        inputs: [
            { name: "program_id", type: "bytes32" as const },
            {
                name: "accounts",
                type: "tuple[]" as const,
                components: [
                    { name: "pubkey", type: "bytes32" as const },
                    { name: "is_signer", type: "bool" as const },
                    { name: "is_writable", type: "bool" as const },
                ],
            },
            { name: "data", type: "bytes" as const },
        ],
        outputs: [] as const,
    }] as const;

    const directCalldata = encodeFunctionData({
        abi: cpiAbi,
        functionName: "invoke",
        args: [tokenBridgeHex, accounts, "0x03"],
    });

    console.log("Direct CPI calldata selector:", directCalldata.slice(0, 10));
    console.log("Direct CPI calldata length:", (directCalldata.length - 2) / 2, "bytes");

    // Try the direct CPI first
    console.log("\nTrying direct CPI invoke to Token Bridge...");
    try {
        const txHash = await wallet.sendTransaction({
            to: CPI_PRECOMPILE,
            data: directCalldata,
            gas: 10_000_000n,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log("Direct CPI TX:", txHash, "status:", receipt.status);
    } catch (e: any) {
        console.error("Direct CPI failed:", e.message?.slice(0, 500));
    }

    // Try approach 2: via RomeWormholeBridge contract
    console.log("\n--- Approach 2: Via RomeWormholeBridge.invokeTokenBridge ---");
    const bridgeInvokeCalldata = encodeFunctionData({
        abi: [{
            name: "invokeTokenBridge",
            type: "function" as const,
            stateMutability: "nonpayable" as const,
            inputs: [
                { name: "tokenBridgeProgramId", type: "bytes32" as const },
                {
                    name: "accounts",
                    type: "tuple[]" as const,
                    components: [
                        { name: "pubkey", type: "bytes32" as const },
                        { name: "is_signer", type: "bool" as const },
                        { name: "is_writable", type: "bool" as const },
                    ],
                },
                { name: "data", type: "bytes" as const },
            ],
            outputs: [] as const,
        }],
        functionName: "invokeTokenBridge",
        args: [tokenBridgeHex, accounts, "0x03"],
    });

    console.log("Trying via bridge.invokeTokenBridge...");
    try {
        const txHash = await wallet.sendTransaction({
            to: BRIDGE_ADDRESS as `0x${string}`,
            data: bridgeInvokeCalldata,
            gas: 10_000_000n,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log("Bridge invoke TX:", txHash, "status:", receipt.status);
    } catch (e: any) {
        console.error("Bridge invoke failed:", e.message?.slice(0, 500));
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
