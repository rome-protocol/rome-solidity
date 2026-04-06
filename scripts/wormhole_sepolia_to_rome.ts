/**
 * Bridge tokens from Sepolia → Rome EVM via Wormhole.
 *
 * Two phases:
 *   Phase 1 (Sepolia):  Lock tokens on Sepolia Token Bridge → get VAA
 *   Phase 2 (Rome):     Post VAA + claimCompleteWrapped on RomeWormholeBridge
 *
 * Usage:
 *   # Phase 1: Send from Sepolia (wraps & locks ETH)
 *   PHASE=send npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network sepolia
 *
 *   # Phase 2: Claim on Rome (after VAA is available)
 *   PHASE=claim VAA_BYTES=<hex> npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network monti_spl
 */
import hardhat from "hardhat";
import { PublicKey } from "@solana/web3.js";
import { encodeFunctionData, parseEther } from "viem";
import {
    publicKeyToBytes32Hex,
    solanaAccountMetasToRome,
    encodeRomeWormholeClaimCompleteWrapped,
} from "@wormhole-foundation/sdk-solana";
import {
    deriveTokenBridgeConfigKey,
    deriveCustodySignerKey,
    deriveEndpointKey,
    deriveMintAuthorityKey,
    deriveWrappedMintKey,
    deriveWrappedMetaKey,
} from "@wormhole-foundation/sdk-solana-tokenbridge";

// ---------------------------------------------------------------------------
// Wormhole contract addresses
// ---------------------------------------------------------------------------

// Sepolia (Ethereum testnet)
const SEPOLIA_CORE_BRIDGE   = "0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78";
const SEPOLIA_TOKEN_BRIDGE  = "0xDB5492265f6038831E89f495670FF909aDe94bd9";
const SEPOLIA_CHAIN_ID      = 10002; // Wormhole chain ID for Sepolia

// Solana Devnet (used by Rome)
const WORMHOLE_CORE   = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
const TOKEN_BRIDGE    = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const SPL_TOKEN_PK    = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM     = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Rome EVM
const BRIDGE_ADDRESS = "0xbea26188700465d33eb29a0f4ada72de0fb08780";

// Solana chain ID in Wormhole = 1
const SOLANA_CHAIN_ID = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pkHex(pk: PublicKey): `0x${string}` {
    return `0x${Buffer.from(pk.toBytes()).toString("hex")}` as `0x${string}`;
}
function getAta(mint: PublicKey, owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), SPL_TOKEN_PK.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM,
    )[0];
}
function deriveAddress(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, programId)[0];
}
function derivePostedVaaKey(wormhole: PublicKey, hash: Buffer): PublicKey {
    return deriveAddress([Buffer.from("PostedVAA"), hash], wormhole);
}
function deriveClaimKey(program: PublicKey, emitterAddr: Buffer, emitterChain: number, sequence: bigint): PublicKey {
    const chainBuf = Buffer.alloc(2);
    chainBuf.writeUInt16LE(emitterChain);
    const seqBuf = Buffer.alloc(8);
    seqBuf.writeBigUInt64BE(sequence);
    return deriveAddress([emitterAddr, chainBuf, seqBuf], program);
}

// ---------------------------------------------------------------------------
// Wormhole Token Bridge ABI (Sepolia EVM side)
// ---------------------------------------------------------------------------

const TOKEN_BRIDGE_ABI = [
    "function wrapAndTransferETH(uint16 recipientChain, bytes32 recipient, uint256 arbiterFee, uint32 nonce) payable returns (uint64 sequence)",
    "function transferTokens(address token, uint256 amount, uint16 recipientChain, bytes32 recipient, uint256 arbiterFee, uint32 nonce) payable returns (uint64 sequence)",
] as const;

// ---------------------------------------------------------------------------
// Phase 1: Send from Sepolia
// ---------------------------------------------------------------------------

async function sendFromSepolia() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    console.log("=== Phase 1: Send ETH from Sepolia ===");
    console.log("Wallet:", wallet.account.address);
    const balance = await publicClient.getBalance({ address: wallet.account.address });
    console.log("ETH Balance:", balance.toString(), `(${Number(balance) / 1e18} ETH)`);

    if (balance < parseEther("0.01")) {
        console.log("\nInsufficient ETH. Get Sepolia ETH from:");
        console.log("  https://sepoliafaucet.com/");
        console.log("  https://www.alchemy.com/faucets/ethereum-sepolia");
        return;
    }

    // Recipient = your Rome PDA (32 bytes, left-padded)
    // We need to get the PDA from Rome, but since we're on Sepolia we hardcode it
    // or read it from a config. For now, derive it from the wallet address.
    // IMPORTANT: Replace this with your actual Rome PDA if different!
    const recipientPdaHex = "0x1f8d99b0be76e3e279322fb00689009cf921507c8210041ed6f6d2732b2d5ce0" as `0x${string}`;
    console.log("\nRecipient (Rome PDA):", recipientPdaHex);

    const SEND_AMOUNT = parseEther("0.001"); // 0.001 ETH

    console.log(`\nSending ${Number(SEND_AMOUNT) / 1e18} ETH to Wormhole Token Bridge...`);
    console.log("Token Bridge:", SEPOLIA_TOKEN_BRIDGE);
    console.log("Recipient chain: Solana (chain ID", SOLANA_CHAIN_ID, ")");

    const calldata = encodeFunctionData({
        abi: [{
            name: "wrapAndTransferETH",
            type: "function" as const,
            stateMutability: "payable" as const,
            inputs: [
                { name: "recipientChain", type: "uint16" as const },
                { name: "recipient", type: "bytes32" as const },
                { name: "arbiterFee", type: "uint256" as const },
                { name: "nonce", type: "uint32" as const },
            ],
            outputs: [{ name: "sequence", type: "uint64" as const }],
        }],
        functionName: "wrapAndTransferETH",
        args: [
            SOLANA_CHAIN_ID,      // recipientChain (1 = Solana)
            recipientPdaHex,      // recipient (your PDA as bytes32)
            0n,                   // arbiterFee (0 for manual relay)
            0,                    // nonce
        ],
    });

    try {
        const txHash = await wallet.sendTransaction({
            to: SEPOLIA_TOKEN_BRIDGE as `0x${string}`,
            data: calldata,
            value: SEND_AMOUNT,
            gas: 500_000n,
        });
        console.log("\nTX submitted:", txHash);

        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log("Status:", receipt.status);
        console.log("Block:", receipt.blockNumber.toString());

        // Parse the sequence number from logs
        // The Token Bridge emits a LogMessagePublished event via Core Bridge
        console.log("\n=== Next Steps ===");
        console.log("1. Wait ~15 minutes for Wormhole guardians to sign the VAA");
        console.log("2. Check for VAA at:");
        console.log(`   https://api.testnet.wormholescan.io/api/v1/vaas/${SEPOLIA_CHAIN_ID}`);
        console.log(`   Or search your TX on https://wormholescan.io/#/txs?query=${txHash}`);
        console.log("3. Once the VAA is available, copy the hex bytes and run Phase 2:");
        console.log(`   PHASE=claim VAA_BYTES=<hex> npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network monti_spl`);
    } catch (e: any) {
        console.log("TX failed:", e.message?.slice(0, 300));
    }
}

// ---------------------------------------------------------------------------
// Phase 2: Claim on Rome
// ---------------------------------------------------------------------------

async function claimOnRome() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    const bridge = await viem.getContractAt("RomeWormholeBridge", BRIDGE_ADDRESS);

    console.log("=== Phase 2: Claim on Rome ===");
    console.log("Wallet:", wallet.account.address);

    const pdaHex = await bridge.read.bridgeUserPda() as `0x${string}`;
    const pda = new PublicKey(Buffer.from(pdaHex.slice(2), "hex"));
    console.log("Your PDA:", pda.toBase58());

    // VAA data — provided via env var or hardcoded for testing
    const vaaHex = process.env.VAA_BYTES;
    if (!vaaHex) {
        console.log("\nNo VAA_BYTES provided. Showing example account layout...\n");
        showExampleClaimAccounts(pda, pdaHex);
        return;
    }

    console.log("VAA length:", vaaHex.length / 2, "bytes");

    // Parse VAA to extract: emitter chain, emitter address, sequence, payload
    const vaaBuf = Buffer.from(vaaHex.replace("0x", ""), "hex");
    const vaaVersion = vaaBuf[0];
    const guardianSetIndex = vaaBuf.readUInt32BE(1);
    const sigCount = vaaBuf[5];
    const bodyOffset = 6 + sigCount * 66;

    const timestamp = vaaBuf.readUInt32BE(bodyOffset);
    const nonce = vaaBuf.readUInt32BE(bodyOffset + 4);
    const emitterChain = vaaBuf.readUInt16BE(bodyOffset + 8);
    const emitterAddress = vaaBuf.subarray(bodyOffset + 10, bodyOffset + 42);
    const sequence = vaaBuf.readBigUInt64BE(bodyOffset + 42);
    const consistencyLevel = vaaBuf[bodyOffset + 50];
    const payload = vaaBuf.subarray(bodyOffset + 51);

    console.log("Emitter chain:", emitterChain);
    console.log("Emitter:", "0x" + emitterAddress.toString("hex"));
    console.log("Sequence:", sequence.toString());

    // Parse token bridge transfer payload
    // Payload type 1 = Transfer
    const payloadType = payload[0];
    if (payloadType !== 1) {
        console.log("Unexpected payload type:", payloadType, "(expected 1 for Transfer)");
    }

    // Bytes 1-32: amount (uint256)
    // Bytes 33-64: token address (32 bytes)
    // Bytes 65-66: token chain (uint16)
    // Bytes 67-98: recipient address (32 bytes)
    // Bytes 99-100: recipient chain (uint16)
    // Bytes 101-132: fee (uint256)
    const tokenAddress = payload.subarray(33, 65);
    const tokenChain = payload.readUInt16BE(65);
    const recipientAddr = payload.subarray(67, 99);
    const recipientChain = payload.readUInt16BE(99);

    console.log("Token chain:", tokenChain, "(origin)");
    console.log("Token:", "0x" + tokenAddress.toString("hex"));
    console.log("Recipient chain:", recipientChain);
    console.log("Recipient:", "0x" + recipientAddr.toString("hex"));

    // Compute VAA hash (keccak256 of body)
    const { keccak256 } = await import("viem");
    const body = vaaBuf.subarray(bodyOffset);
    const bodyHash = keccak256(`0x${body.toString("hex")}` as `0x${string}`);
    const vaaHash = keccak256(bodyHash);
    const vaaHashBuf = Buffer.from(vaaHash.slice(2), "hex");

    // Token is from Ethereum → it's a wrapped token on Solana
    // Derive the wrapped mint PDA
    const wrappedMint = deriveWrappedMintKey(TOKEN_BRIDGE, tokenChain, tokenAddress);
    console.log("\nWrapped mint on Solana:", wrappedMint.toBase58());

    // Derive recipient ATA for the wrapped mint
    const recipientAta = getAta(wrappedMint, pda);
    console.log("Recipient ATA:", recipientAta.toBase58());

    // Build completeWrapped account list
    // Matches the SDK's getCompleteTransferWrappedAccounts
    const { utils: coreUtils } = await import("@wormhole-foundation/sdk-solana-core");

    const claimAccounts = [
        { pubkey: pda, isSigner: true, isWritable: true },                                        // payer
        { pubkey: deriveTokenBridgeConfigKey(TOKEN_BRIDGE), isSigner: false, isWritable: false },  // config
        { pubkey: derivePostedVaaKey(WORMHOLE_CORE, vaaHashBuf), isSigner: false, isWritable: false }, // vaa
        { pubkey: deriveClaimKey(TOKEN_BRIDGE, emitterAddress, emitterChain, sequence), isSigner: false, isWritable: true }, // claim
        { pubkey: deriveEndpointKey(TOKEN_BRIDGE, emitterChain, emitterAddress), isSigner: false, isWritable: false }, // endpoint
        { pubkey: recipientAta, isSigner: false, isWritable: true },                              // to
        { pubkey: recipientAta, isSigner: false, isWritable: true },                              // toFees (= to)
        { pubkey: wrappedMint, isSigner: false, isWritable: true },                               // mint
        { pubkey: deriveWrappedMetaKey(TOKEN_BRIDGE, wrappedMint), isSigner: false, isWritable: false }, // wrappedMeta
        { pubkey: deriveMintAuthorityKey(TOKEN_BRIDGE), isSigner: false, isWritable: false },     // mintAuthority
        { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
        { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },     // system program
        { pubkey: SPL_TOKEN_PK, isSigner: false, isWritable: false },
        { pubkey: WORMHOLE_CORE, isSigner: false, isWritable: false },
    ];

    const claimCalldata = encodeRomeWormholeClaimCompleteWrapped(
        publicKeyToBytes32Hex(TOKEN_BRIDGE),
        solanaAccountMetasToRome(claimAccounts),
    );

    console.log(`\nClaim accounts: ${claimAccounts.length}`);
    console.log(`Calldata: ${claimCalldata.slice(0, 74)}...`);
    console.log(`Calldata length: ${(claimCalldata.length - 2) / 2} bytes`);

    // Step 1: First, we need to post the VAA to Wormhole Core Bridge
    // This verifies guardian signatures and creates the PostedVAA account
    console.log("\n--- Step 1: Post VAA to Core Bridge ---");
    console.log("(This step requires calling Wormhole Core Bridge verify_signatures + post_vaa)");
    console.log("(In production, the SDK handles this via coreBridge.postVaa())");

    // Step 2: Create ATA for the wrapped token if it doesn't exist
    console.log("\n--- Step 2: Create ATA for wrapped mint (if needed) ---");

    // Step 3: Call claimCompleteWrapped
    console.log("\n--- Step 3: claimCompleteWrapped ---");
    console.log("Uncomment to execute:");
    console.log("// const tx = await wallet.sendTransaction({");
    console.log("//     to: BRIDGE_ADDRESS, data: claimCalldata, gas: 5_000_000n,");
    console.log("// });");
}

function showExampleClaimAccounts(pda: PublicKey, pdaHex: string) {
    console.log("To claim, you need a VAA from Wormholescan.");
    console.log("\nExample flow:");
    console.log("  1. Send ETH on Sepolia:");
    console.log("     PHASE=send npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network sepolia");
    console.log("  2. Wait for VAA (~15 min on testnet)");
    console.log("  3. Get VAA bytes from Wormholescan API:");
    console.log("     https://api.testnet.wormholescan.io/api/v1/signed_vaa/10002/<emitter>/<seq>");
    console.log("  4. Claim on Rome:");
    console.log("     PHASE=claim VAA_BYTES=<hex> npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network monti_spl");
    console.log("\nYour recipient address for Sepolia transfers:");
    console.log("  PDA:", pda.toBase58());
    console.log("  Hex:", pdaHex);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const phase = process.env.PHASE || "claim";

    if (phase === "send") {
        await sendFromSepolia();
    } else {
        await claimOnRome();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
