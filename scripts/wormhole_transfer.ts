/**
 * End-to-end Wormhole transfer via RomeWormholeBridge, using wormhole-sdk-ts directly.
 *
 * Uses:
 *   @wormhole-foundation/sdk-solana           — romeEvm encoding helpers
 *   @wormhole-foundation/sdk-solana-tokenbridge — account derivation & instruction builders
 *
 * Usage:
 *   npx hardhat run scripts/wormhole_transfer.ts --network monti_spl
 */
import hardhat from "hardhat";
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

// ---- SDK: romeEvm encoding helpers ----
import {
    publicKeyToBytes32Hex,
    solanaAccountMetasToRome,
    encodeRomeWormholeSendTransferNative,
    encodeRomeWormholeClaimCompleteNative,
} from "@wormhole-foundation/sdk-solana";

// ---- SDK: account derivation ----
import {
    getTransferNativeAccounts,
    getCompleteTransferNativeAccounts,
    deriveAuthoritySignerKey,
} from "@wormhole-foundation/sdk-solana-tokenbridge";

// ---------------------------------------------------------------------------
// Program IDs (Solana Devnet)
// ---------------------------------------------------------------------------

const WORMHOLE_CORE = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
const TOKEN_BRIDGE = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const BRIDGE_ADDRESS = "0xbea26188700465d33eb29a0f4ada72de0fb08780";

// ---------------------------------------------------------------------------
// ATA derivation (lightweight, no @solana/spl-token dependency needed)
// ---------------------------------------------------------------------------

function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
    const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), SPL_TOKEN.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM,
    )[0];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    const bridge = await viem.getContractAt("RomeWormholeBridge", BRIDGE_ADDRESS);

    console.log("=== Wormhole Transfer via SDK ===");
    console.log("Wallet:", wallet.account.address);

    // User's Solana PDA (derived on-chain by the contract on Rome EVM).
    // On a simulated network the precompile won't exist, so we fall back to a dummy PDA.
    let userPda: PublicKey;
    try {
        const userPdaHex = await bridge.read.bridgeUserPda();
        userPda = new PublicKey(Buffer.from((userPdaHex as string).slice(2), "hex"));
    } catch {
        console.log("(bridgeUserPda not available — using deterministic placeholder for dry-run)");
        userPda = PublicKey.findProgramAddressSync(
            [Buffer.from("rome_evm_user"), Buffer.from(wallet.account.address.slice(2), "hex")],
            new PublicKey("RoLEbzVJF14CBRV5GXJ7kaihYC5gAKjjSfRCkDyLrVE"),
        )[0];
    }
    console.log("Your Solana PDA:", userPda.toBase58());

    // -----------------------------------------------------------------------
    // CONFIGURATION — fill these in for your transfer
    // -----------------------------------------------------------------------

    const MINT = new PublicKey("So11111111111111111111111111111111111111112");
    const AMOUNT = BigInt(100_000);          // lamports
    const TARGET_CHAIN = 2;                  // 2 = Ethereum
    const TARGET_ADDRESS_HEX =
        `0x000000000000000000000000${wallet.account.address.slice(2)}` as `0x${string}`;

    // -----------------------------------------------------------------------
    // 1. SEND: Rome → Ethereum  (sendTransferNative)
    // -----------------------------------------------------------------------

    console.log("\n--- sendTransferNative ---");

    const message = Keypair.generate();
    const senderAta = getAssociatedTokenAddress(MINT, userPda);

    console.log("Message keypair:", message.publicKey.toBase58());
    console.log("Sender ATA:     ", senderAta.toBase58());

    // Use the SDK to derive every transfer account — identical to what the UI does
    const transferAccounts = getTransferNativeAccounts(
        TOKEN_BRIDGE,
        WORMHOLE_CORE,
        userPda,            // payer
        message.publicKey,  // message
        senderAta,          // from (sender's ATA)
        MINT,
        SPL_TOKEN,
    );

    // SDK helper: convert the named struct → ordered AccountMeta[]
    const transferMetas = orderedTransferNativeMetas(transferAccounts);

    // SPL approve accounts: [source, delegate, owner]
    const authoritySigner = deriveAuthoritySignerKey(TOKEN_BRIDGE);
    const approveMetas = [
        { pubkey: senderAta,       isSigner: false, isWritable: true  },
        { pubkey: authoritySigner,  isSigner: false, isWritable: false },
        { pubkey: userPda,          isSigner: true,  isWritable: false },
    ];

    // Encode calldata via romeEvm SDK module
    const sendCalldata = encodeRomeWormholeSendTransferNative({
        splTokenProgramId: publicKeyToBytes32Hex(SPL_TOKEN),
        approveAccounts: solanaAccountMetasToRome(approveMetas),
        approveAmount: AMOUNT,
        tokenBridgeProgramId: publicKeyToBytes32Hex(TOKEN_BRIDGE),
        transferAccounts: solanaAccountMetasToRome(transferMetas),
        nonce: 0,
        amount: AMOUNT,
        fee: 0n,
        targetAddress: TARGET_ADDRESS_HEX,
        targetChain: TARGET_CHAIN,
    });

    console.log(`Approve accounts:  ${approveMetas.length}`);
    console.log(`Transfer accounts: ${transferMetas.length}`);
    console.log(`Calldata:          ${sendCalldata.slice(0, 74)}...`);
    console.log(`Calldata length:   ${(sendCalldata.length - 2) / 2} bytes`);

    // Uncomment to execute:
    // const txHash = await wallet.sendTransaction({
    //     to: BRIDGE_ADDRESS as `0x${string}`,
    //     data: sendCalldata,
    //     gas: 2_000_000n,
    // });
    // console.log("TX:", txHash);
    // const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    // console.log("Status:", receipt.status);

    // -----------------------------------------------------------------------
    // 2. CLAIM: Ethereum → Rome  (claimCompleteNative)
    //    Requires a real VAA. Placeholder values below.
    // -----------------------------------------------------------------------

    console.log("\n--- claimCompleteNative (placeholder) ---");
    console.log("Replace the placeholder VAA data with real values from Wormholescan.");

    // Placeholder — fill from a real Wormholescan VAA
    const vaaHash = Buffer.alloc(32);
    const emitterAddress = Buffer.alloc(32);
    const emitterChain = 2; // Ethereum
    const sequence = 1n;

    // To use getCompleteTransferNativeAccounts we need a parsed VAA object.
    // For now we derive accounts manually using the same PDAs the SDK uses.
    const recipientAta = getAssociatedTokenAddress(MINT, userPda);

    // The SDK's getCompleteTransferNativeAccounts requires a parsed TokenBridge.TransferVAA.
    // In a real integration you'd parse the VAA via the SDK and pass it directly.
    // Here we show the manual account list so the script is self-contained.
    const { utils: coreUtils } = await import("@wormhole-foundation/sdk-solana-core");
    const { deriveTokenBridgeConfigKey, deriveCustodyKey, deriveCustodySignerKey, deriveEndpointKey } =
        await import("@wormhole-foundation/sdk-solana-tokenbridge");

    const claimMetas = [
        { pubkey: userPda, isSigner: true, isWritable: true },
        { pubkey: deriveTokenBridgeConfigKey(TOKEN_BRIDGE), isSigner: false, isWritable: false },
        { pubkey: coreUtils.derivePostedVaaKey(WORMHOLE_CORE, vaaHash), isSigner: false, isWritable: false },
        { pubkey: coreUtils.deriveClaimKey(TOKEN_BRIDGE, emitterAddress, emitterChain, sequence), isSigner: false, isWritable: true },
        { pubkey: deriveEndpointKey(TOKEN_BRIDGE, emitterChain, emitterAddress), isSigner: false, isWritable: false },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },  // toFees = to
        { pubkey: deriveCustodyKey(TOKEN_BRIDGE, MINT), isSigner: false, isWritable: true },
        { pubkey: MINT, isSigner: false, isWritable: false },
        { pubkey: deriveCustodySignerKey(TOKEN_BRIDGE), isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_TOKEN, isSigner: false, isWritable: false },
        { pubkey: WORMHOLE_CORE, isSigner: false, isWritable: false },
    ];

    const claimCalldata = encodeRomeWormholeClaimCompleteNative(
        publicKeyToBytes32Hex(TOKEN_BRIDGE),
        solanaAccountMetasToRome(claimMetas),
    );

    console.log(`Claim accounts:  ${claimMetas.length}`);
    console.log(`Calldata:        ${claimCalldata.slice(0, 74)}...`);
    console.log(`Calldata length: ${(claimCalldata.length - 2) / 2} bytes`);

    // Uncomment to execute:
    // const claimTx = await wallet.sendTransaction({
    //     to: BRIDGE_ADDRESS as `0x${string}`,
    //     data: claimCalldata,
    //     gas: 2_000_000n,
    // });
    // console.log("Claim TX:", claimTx);

    // -----------------------------------------------------------------------
    console.log("\n=== Done ===");
    console.log("Account lists built via @wormhole-foundation/sdk-solana-tokenbridge");
    console.log("Calldata encoded via @wormhole-foundation/sdk-solana romeEvm module");
    console.log("Uncomment sendTransaction calls above to execute for real.");
}

// ---------------------------------------------------------------------------
// Convert the named TransferNativeAccounts struct to an ordered AccountMeta[]
// matching the Anchor IDL order for transfer_native.
// ---------------------------------------------------------------------------

function orderedTransferNativeMetas(accts: {
    payer: PublicKey;
    config: PublicKey;
    from: PublicKey;
    mint: PublicKey;
    custody: PublicKey;
    authoritySigner: PublicKey;
    custodySigner: PublicKey;
    wormholeBridge: PublicKey;
    wormholeMessage: PublicKey;
    wormholeEmitter: PublicKey;
    wormholeSequence: PublicKey;
    wormholeFeeCollector: PublicKey;
    clock: PublicKey;
    rent: PublicKey;
    systemProgram: PublicKey;
    tokenProgram: PublicKey;
    wormholeProgram: PublicKey;
}) {
    return [
        { pubkey: accts.payer,                isSigner: true,  isWritable: true  },
        { pubkey: accts.config,               isSigner: false, isWritable: false },
        { pubkey: accts.from,                 isSigner: false, isWritable: true  },
        { pubkey: accts.mint,                 isSigner: false, isWritable: false },
        { pubkey: accts.custody,              isSigner: false, isWritable: true  },
        { pubkey: accts.authoritySigner,      isSigner: false, isWritable: false },
        { pubkey: accts.custodySigner,        isSigner: false, isWritable: false },
        { pubkey: accts.wormholeBridge,       isSigner: false, isWritable: true  },
        { pubkey: accts.wormholeMessage,      isSigner: true,  isWritable: true  },
        { pubkey: accts.wormholeEmitter,      isSigner: false, isWritable: false },
        { pubkey: accts.wormholeSequence,     isSigner: false, isWritable: true  },
        { pubkey: accts.wormholeFeeCollector, isSigner: false, isWritable: true  },
        { pubkey: accts.clock,                isSigner: false, isWritable: false },
        { pubkey: accts.rent,                 isSigner: false, isWritable: false },
        { pubkey: accts.systemProgram,        isSigner: false, isWritable: false },
        { pubkey: accts.tokenProgram,         isSigner: false, isWritable: false },
        { pubkey: accts.wormholeProgram,      isSigner: false, isWritable: false },
    ];
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
