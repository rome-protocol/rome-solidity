/**
 * Outbound Wormhole transfer: Rome EVM (wrapped WETH) → Sepolia ETH.
 *
 * Two-step hybrid approach (same pattern as the inbound claim):
 *   Step 1a: Transfer tokens from PDA's ATA to payer's ATA (via Rome EVM CPI to SPL Token)
 *   Step 1b: Wormhole transferWrapped as native Solana transaction (bypasses proxy emulator)
 *
 * The Rome EVM proxy emulator cannot simulate complex Wormhole CPI chains (same limitation
 * that required the inbound claim to use native Solana transactions). The hybrid approach:
 * - Uses Rome EVM only for the simple SPL token transfer (single CPI, emulator handles this)
 * - Does the Wormhole transfer natively on Solana with the payer keypair + fresh message keypair
 *
 * Prerequisites:
 *   1. RomeWormholeBridge deployed (scripts/deploy_wormhole_bridge.ts)
 *   2. Wrapped WETH balance in your PDA's ATA on Rome (from a prior inbound transfer)
 *   3. SOL in your Solana payer (derived from EVM key) for native Solana tx fees
 *
 * Usage:
 *   # Step 1 — Send wrapped tokens from Rome via Token Bridge. Prints sequence number.
 *   PHASE=send npx hardhat run scripts/wormhole_rome_to_sepolia.ts --network monti_spl
 *
 *   # Step 2 — Claim ETH on Sepolia (~15 min after guardians sign the VAA).
 *   PHASE=claim SEQ=<sequence> npx hardhat run scripts/wormhole_rome_to_sepolia.ts --network sepolia
 *
 * Environment:
 *   MONTI_SPL_PRIVATE_KEY  — hex private key (with 0x prefix)
 *   SEPOLIA_PRIVATE_KEY    — same key, used on Sepolia
 *   PHASE                  — "send" or "claim"
 *   SEQ                    — Wormhole sequence number (from Step 1 output)
 *   VAA_B64                — (optional) base64-encoded signed VAA (skips polling)
 *   BRIDGE                 — (optional) RomeWormholeBridge address override
 *   AMOUNT                 — (optional) amount in base units (default 10000 = 0.0001 WETH)
 *   USDC_ADDRESS           — (optional) Sepolia USDC (0x...). When set, uses wrapped USDC mint on
 *                            Solana and claims with completeTransfer (not unwrap ETH).
 */
import hardhat from "hardhat";
import {
    Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
    sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY,
    SystemProgram as SolanaSystemProgram,
} from "@solana/web3.js";
import { encodeFunctionData } from "viem";
import {
    publicKeyToBytes32Hex,
    solanaAccountMetasToRome,
} from "@wormhole-foundation/sdk-solana";
import {
    deriveAuthoritySignerKey,
    deriveTokenBridgeConfigKey,
    deriveWrappedMintKey,
    deriveWrappedMetaKey,
    deriveSenderAccountKey,
} from "@wormhole-foundation/sdk-solana-tokenbridge";
import { utils as coreUtils } from "@wormhole-foundation/sdk-solana-core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Sepolia (target chain)
const SEPOLIA_TOKEN_BRIDGE = "0xDB5492265f6038831E89f495670FF909aDe94bd9";
const SEPOLIA_WORMHOLE_CHAIN_ID = 10002;
const ETHEREUM_CHAIN_ID = 2; // Wormhole chain ID for Ethereum
const SOLANA_EMITTER_CHAIN = 1;

// WETH on Sepolia (default outbound asset when USDC_ADDRESS is unset)
const SEPOLIA_WETH_PADDED = Buffer.from(
    "000000000000000000000000eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c", "hex",
);

function getSepoliaForeignAssetPadded(): Buffer {
    const addr = process.env.USDC_ADDRESS?.trim();
    if (addr?.startsWith("0x") && addr.length === 42) {
        return Buffer.from(addr.replace(/^0x/i, "").padStart(64, "0"), "hex");
    }
    return SEPOLIA_WETH_PADDED;
}

// Solana Devnet
const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
const WORMHOLE_CORE = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
const TOKEN_BRIDGE = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const SPL_TOKEN_PK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Rome EVM
const DEFAULT_BRIDGE = "0x2eb91e687247300853f392c4a903609df0cf8fcb";
const ROME_EVM_PROGRAM = new PublicKey(
    process.env.ROME_EVM_PROGRAM || "DP1dshBzmXXVsRxH5kCKMemrDuptg1JvJ1j5AsFV4Hm3",
);

// Wormholescan API
const WORMHOLESCAN_API = "https://api.testnet.wormholescan.io/api/v1/vaas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAta(mint: PublicKey, owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), SPL_TOKEN_PK.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM,
    )[0];
}

function getEvmPrivateKey(): string {
    const raw = process.env.MONTI_SPL_PRIVATE_KEY || process.env.SEPOLIA_PRIVATE_KEY || "";
    return raw.replace(/^0x/, "");
}

/** Derive the user's PDA off-chain (same as RomeEVMAccount.pda() on-chain). */
function deriveUserPda(evmAddress: string): PublicKey {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("EXTERNAL_AUTHORITY"), Buffer.from(evmAddress.slice(2), "hex")],
        ROME_EVM_PROGRAM,
    )[0];
}

/** Encode SPL Token Transfer instruction data: discriminator 3 + u64 LE amount */
function encodeSplTransfer(amount: bigint): Buffer {
    const buf = Buffer.alloc(9);
    buf[0] = 3; // Transfer discriminator
    buf.writeBigUInt64LE(amount, 1);
    return buf;
}

/** Encode SPL Token Approve instruction data: discriminator 4 + u64 LE amount */
function encodeSplApprove(amount: bigint): Buffer {
    const buf = Buffer.alloc(9);
    buf[0] = 4; // Approve discriminator
    buf.writeBigUInt64LE(amount, 1);
    return buf;
}

async function fetchSignedVaa(
    emitterChain: number,
    emitterAddress: string,
    seq: number,
    maxWaitMs = 900_000,
): Promise<string> {
    const url = `${WORMHOLESCAN_API}/${emitterChain}/${emitterAddress}/${seq}`;
    const start = Date.now();
    let attempt = 0;

    while (Date.now() - start < maxWaitMs) {
        attempt++;
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        process.stdout.write(`\r  Polling Wormholescan (attempt ${attempt}, ${elapsed}s)...`);

        try {
            const res = await fetch(url);
            if (res.ok) {
                const json = await res.json() as any;
                const vaaB64 = json?.data?.vaa;
                if (vaaB64) {
                    console.log(" found!");
                    return vaaB64;
                }
            }
        } catch { /* retry */ }

        await new Promise(r => setTimeout(r, 15_000));
    }

    throw new Error(`VAA not found after ${maxWaitMs / 1000}s. Check Wormholescan manually.`);
}

// ---------------------------------------------------------------------------
// Phase 1: Send from Rome (2-step hybrid)
// ---------------------------------------------------------------------------

async function sendFromRome() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    const bridgeAddr = (process.env.BRIDGE || DEFAULT_BRIDGE) as `0x${string}`;
    const bridge = await viem.getContractAt("RomeWormholeBridge", bridgeAddr);

    console.log("=== Phase 1: Send wrapped tokens from Rome → Sepolia ===");
    console.log("Wallet:", wallet.account.address);
    console.log("Bridge:", bridgeAddr);

    // 1. Get user PDA
    let userPda: PublicKey;
    try {
        const pdaHex = await bridge.read.bridgeUserPda() as `0x${string}`;
        userPda = new PublicKey(Buffer.from(pdaHex.slice(2), "hex"));
    } catch {
        userPda = deriveUserPda(wallet.account.address);
    }
    console.log("User PDA:", userPda.toBase58());

    // 2. Derive payer keypair (same key as EVM, used for native Solana txs)
    const evmKey = getEvmPrivateKey();
    if (!evmKey) throw new Error("Set MONTI_SPL_PRIVATE_KEY env var");
    const payer = Keypair.fromSeed(Buffer.from(evmKey, "hex"));
    console.log("Payer (Solana):", payer.publicKey.toBase58());

    // 3. Check balances
    const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");
    const foreignAsset = getSepoliaForeignAssetPadded();
    const wrappedMint = deriveWrappedMintKey(TOKEN_BRIDGE, SEPOLIA_WORMHOLE_CHAIN_ID, foreignAsset);
    const pdaAta = getAta(wrappedMint, userPda);
    const payerAta = getAta(wrappedMint, payer.publicKey);

    console.log("Wrapped mint:", wrappedMint.toBase58());
    console.log("PDA ATA:", pdaAta.toBase58());
    console.log("Payer ATA:", payerAta.toBase58());

    const pdaAtaInfo = await connection.getAccountInfo(pdaAta);
    if (!pdaAtaInfo || pdaAtaInfo.data.length < 72) {
        console.log("\nERROR: PDA ATA does not exist. Run an inbound transfer first.");
        return;
    }
    const pdaBalance = pdaAtaInfo.data.readBigUInt64LE(64);
    const unitLabel = process.env.USDC_ADDRESS ? "USDC (6dp)" : "WETH (8dp)";
    console.log("PDA ATA balance:", pdaBalance.toString(), `(${unitLabel} base units)`);

    const amount = BigInt(process.env.AMOUNT || "10000");
    if (pdaBalance < amount) {
        console.log(`\nERROR: Insufficient balance. Have ${pdaBalance}, need ${amount}.`);
        return;
    }

    // -----------------------------------------------------------------------
    // Step 1a: Transfer tokens from PDA ATA → Payer ATA (via Rome EVM CPI)
    // -----------------------------------------------------------------------
    console.log("\n--- Step 1a: Transfer tokens from PDA ATA → Payer ATA ---");

    // Create payer's ATA if it doesn't exist
    const payerAtaInfo = await connection.getAccountInfo(payerAta);
    if (!payerAtaInfo) {
        console.log("Creating payer ATA via Rome EVM Associated Token precompile...");
        const ASSOC_TOKEN_PRECOMPILE = "0xFF00000000000000000000000000000000000006" as const;
        const mintHex = publicKeyToBytes32Hex(wrappedMint);
        // Use create_associated_token_account_idempotent for the payer
        // Note: this creates an ATA owned by the payer, NOT by the Rome EVM PDA
        // We use native Solana to create the payer's ATA since the precompile creates
        // ATAs for Rome EVM addresses
        const createAtaIx = new TransactionInstruction({
            programId: ATA_PROGRAM,
            keys: [
                { pubkey: payer.publicKey, isSigner: true, isWritable: true },
                { pubkey: payerAta, isSigner: false, isWritable: true },
                { pubkey: payer.publicKey, isSigner: false, isWritable: false },
                { pubkey: wrappedMint, isSigner: false, isWritable: false },
                { pubkey: SolanaSystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: SPL_TOKEN_PK, isSigner: false, isWritable: false },
            ],
            data: Buffer.alloc(0), // CreateIdempotent has no data
        });
        const createAtaTx = new Transaction().add(createAtaIx);
        createAtaTx.feePayer = payer.publicKey;
        const sig = await sendAndConfirmTransaction(connection, createAtaTx, [payer]);
        console.log("Payer ATA created:", sig);
    } else {
        console.log("Payer ATA already exists.");
    }

    // Transfer tokens from PDA ATA to Payer ATA via bridge's invokeSplToken
    console.log(`Transferring ${amount} tokens from PDA ATA to Payer ATA...`);

    const transferAccounts = [
        { pubkey: publicKeyToBytes32Hex(pdaAta),          isSigner: false, isWritable: true  },
        { pubkey: publicKeyToBytes32Hex(payerAta),        isSigner: false, isWritable: true  },
        { pubkey: publicKeyToBytes32Hex(userPda),         isSigner: true,  isWritable: false },
    ];

    const transferCalldata = encodeFunctionData({
        abi: [{
            name: "invokeSplToken",
            type: "function" as const,
            stateMutability: "nonpayable" as const,
            inputs: [
                { name: "splTokenProgramId", type: "bytes32" as const },
                { name: "accounts", type: "tuple[]" as const, components: [
                    { name: "pubkey", type: "bytes32" as const },
                    { name: "isSigner", type: "bool" as const },
                    { name: "isWritable", type: "bool" as const },
                ]},
                { name: "data", type: "bytes" as const },
            ],
            outputs: [] as const,
        }],
        functionName: "invokeSplToken",
        args: [
            publicKeyToBytes32Hex(SPL_TOKEN_PK),
            transferAccounts.map(a => ({ pubkey: a.pubkey, isSigner: a.isSigner, isWritable: a.isWritable })),
            `0x${encodeSplTransfer(amount).toString("hex")}` as `0x${string}`,
        ],
    });

    const transferTxHash = await wallet.sendTransaction({
        to: bridgeAddr,
        data: transferCalldata,
        gas: 5_000_000n,
    });
    const transferReceipt = await publicClient.waitForTransactionReceipt({ hash: transferTxHash });
    console.log("Transfer TX:", transferTxHash);
    console.log("Transfer status:", transferReceipt.status);

    if (transferReceipt.status !== "success") {
        console.log("\nERROR: Token transfer failed. Cannot proceed with outbound.");
        return;
    }

    // Verify payer ATA balance
    const payerAtaAfter = await connection.getAccountInfo(payerAta);
    if (payerAtaAfter && payerAtaAfter.data.length >= 72) {
        const payerBalance = payerAtaAfter.data.readBigUInt64LE(64);
        console.log("Payer ATA balance after transfer:", payerBalance.toString());
    }

    // -----------------------------------------------------------------------
    // Step 1b: Wormhole transferWrapped (native Solana tx)
    // -----------------------------------------------------------------------
    console.log("\n--- Step 1b: Wormhole transferWrapped (native Solana) ---");

    const message = Keypair.generate();
    console.log("Message keypair:", message.publicKey.toBase58());

    // Target: the user's own address on Ethereum, padded to bytes32
    const targetAddress = Buffer.alloc(32);
    Buffer.from(wallet.account.address.slice(2), "hex").copy(targetAddress, 12);

    // Build transferWrapped instruction
    const authoritySigner = deriveAuthoritySignerKey(TOKEN_BRIDGE);
    const tokenBridgeConfig = deriveTokenBridgeConfigKey(TOKEN_BRIDGE);
    const wrappedMeta = deriveWrappedMetaKey(TOKEN_BRIDGE, wrappedMint);
    const senderAccount = deriveSenderAccountKey(TOKEN_BRIDGE);
    const wormholeBridge = coreUtils.deriveWormholeBridgeDataKey(WORMHOLE_CORE);
    const wormholeEmitter = coreUtils.deriveWormholeEmitterKey(TOKEN_BRIDGE);
    const wormholeSequence = coreUtils.deriveEmitterSequenceKey(wormholeEmitter, WORMHOLE_CORE);
    const wormholeFeeCollector = coreUtils.deriveFeeCollectorKey(WORMHOLE_CORE);

    // First: SPL approve
    const approveIx = new TransactionInstruction({
        programId: SPL_TOKEN_PK,
        keys: [
            { pubkey: payerAta, isSigner: false, isWritable: true },
            { pubkey: authoritySigner, isSigner: false, isWritable: false },
            { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: encodeSplApprove(amount),
    });

    // Encode transferWrapped instruction data: discriminator 4 + payload
    // TransferWrapped: instruction index 4
    // Payload: nonce(u32) + amount(u64) + fee(u64) + target_address(32) + target_chain(u16)
    const transferData = Buffer.alloc(55);
    transferData[0] = 4; // TransferWrapped instruction discriminator
    transferData.writeUInt32LE(0, 1); // nonce
    transferData.writeBigUInt64LE(amount, 5); // amount
    transferData.writeBigUInt64LE(0n, 13); // fee
    targetAddress.copy(transferData, 21); // target_address
    transferData.writeUInt16LE(ETHEREUM_CHAIN_ID, 53); // target_chain

    const transferWrappedIx = new TransactionInstruction({
        programId: TOKEN_BRIDGE,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: tokenBridgeConfig, isSigner: false, isWritable: false },
            { pubkey: payerAta, isSigner: false, isWritable: true },
            { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // fromOwner
            { pubkey: wrappedMint, isSigner: false, isWritable: true },
            { pubkey: wrappedMeta, isSigner: false, isWritable: false },
            { pubkey: authoritySigner, isSigner: false, isWritable: false },
            { pubkey: wormholeBridge, isSigner: false, isWritable: true },
            { pubkey: message.publicKey, isSigner: true, isWritable: true },
            { pubkey: wormholeEmitter, isSigner: false, isWritable: false },
            { pubkey: wormholeSequence, isSigner: false, isWritable: true },
            { pubkey: wormholeFeeCollector, isSigner: false, isWritable: true },
            { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SolanaSystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SPL_TOKEN_PK, isSigner: false, isWritable: false },
            { pubkey: WORMHOLE_CORE, isSigner: false, isWritable: false },
            { pubkey: senderAccount, isSigner: false, isWritable: false },
        ],
        data: transferData,
    });

    console.log("Sending approve + transferWrapped on Solana...");
    const tx = new Transaction().add(approveIx, transferWrappedIx);
    tx.feePayer = payer.publicKey;
    const sig = await sendAndConfirmTransaction(connection, tx, [payer, message]);
    console.log("Solana TX:", sig);

    // Check remaining balances
    const pdaAtaAfter = await connection.getAccountInfo(pdaAta);
    if (pdaAtaAfter && pdaAtaAfter.data.length >= 72) {
        console.log("PDA ATA balance after:", pdaAtaAfter.data.readBigUInt64LE(64).toString());
    }
    const payerAtaFinal = await connection.getAccountInfo(payerAta);
    if (payerAtaFinal && payerAtaFinal.data.length >= 72) {
        console.log("Payer ATA balance after:", payerAtaFinal.data.readBigUInt64LE(64).toString());
    }

    // Find the sequence number from the Wormhole emitter
    console.log("\n=== Step 1 complete ===");
    console.log("Wormhole emitter:", wormholeEmitter.toBase58());
    console.log("\nNext steps:");
    console.log("1. Find the Wormhole sequence number on Wormholescan:");
    console.log(`   https://wormholescan.io/#/txs?address=${wormholeEmitter.toBase58()}`);
    console.log("2. Run Step 2 to claim on Sepolia (~15 min after guardians sign):");
    console.log(`   PHASE=claim SEQ=<sequence> npx hardhat run scripts/wormhole_rome_to_sepolia.ts --network sepolia`);
}

// ---------------------------------------------------------------------------
// Phase 2: Claim on Sepolia
// ---------------------------------------------------------------------------

async function claimOnSepolia() {
    let vaaB64: string;

    const solanaTokenBridgeEmitter = coreUtils.deriveWormholeEmitterKey(TOKEN_BRIDGE);
    const emitterHex = Buffer.from(solanaTokenBridgeEmitter.toBytes()).toString("hex");

    if (process.env.VAA_B64) {
        vaaB64 = process.env.VAA_B64;
        console.log("Using VAA from VAA_B64 env var.");
    } else if (process.env.SEQ) {
        const seq = parseInt(process.env.SEQ, 10);
        console.log(`Fetching signed VAA for Solana emitter, sequence ${seq}...`);
        vaaB64 = await fetchSignedVaa(SOLANA_EMITTER_CHAIN, emitterHex, seq);
    } else {
        throw new Error("Provide SEQ=<sequence> or VAA_B64=<base64>. SEQ comes from Phase 1 output.");
    }

    const vaaBytes = Buffer.from(vaaB64, "base64");

    console.log("\n=== Phase 2: Claim on Sepolia ===");
    console.log("VAA length:", vaaBytes.length, "bytes");

    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    console.log("Wallet:", wallet.account.address);
    const beforeBalance = await publicClient.getBalance({ address: wallet.account.address });
    console.log("ETH balance before:", (Number(beforeBalance) / 1e18).toFixed(6), "ETH");

    const usdcAddr = process.env.USDC_ADDRESS as `0x${string}` | undefined;
    const claimUsdc = Boolean(usdcAddr && usdcAddr.startsWith("0x") && usdcAddr.length === 42);

    let usdcBefore = 0n;
    if (claimUsdc) {
        usdcBefore = await publicClient.readContract({
            address: usdcAddr!,
            abi: [{
                name: "balanceOf",
                type: "function",
                stateMutability: "view",
                inputs: [{ name: "account", type: "address" }],
                outputs: [{ name: "", type: "uint256" }],
            }],
            functionName: "balanceOf",
            args: [wallet.account.address],
        });
        console.log("USDC balance before:", usdcBefore.toString());
    }

    const claimCalldata = encodeFunctionData({
        abi: claimUsdc
            ? [{
                name: "completeTransfer",
                type: "function" as const,
                stateMutability: "nonpayable" as const,
                inputs: [{ name: "encodedVm", type: "bytes" as const }],
                outputs: [] as const,
            }]
            : [{
                name: "completeTransferAndUnwrapETH",
                type: "function" as const,
                stateMutability: "nonpayable" as const,
                inputs: [{ name: "encodedVm", type: "bytes" as const }],
                outputs: [] as const,
            }],
        functionName: claimUsdc ? "completeTransfer" : "completeTransferAndUnwrapETH",
        args: [`0x${vaaBytes.toString("hex")}` as `0x${string}`],
    });

    console.log("\nClaiming on Sepolia Token Bridge...");
    const txHash = await wallet.sendTransaction({
        to: SEPOLIA_TOKEN_BRIDGE as `0x${string}`,
        data: claimCalldata,
        gas: 500_000n,
    });
    console.log("TX:", txHash);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("Status:", receipt.status);

    if (receipt.status === "success") {
        const afterBalance = await publicClient.getBalance({ address: wallet.account.address });
        console.log("\n=== SUCCESS ===");
        console.log("ETH balance after:", (Number(afterBalance) / 1e18).toFixed(6), "ETH");
        if (claimUsdc && usdcAddr) {
            const usdcAfter = await publicClient.readContract({
                address: usdcAddr,
                abi: [{
                    name: "balanceOf",
                    type: "function",
                    stateMutability: "view",
                    inputs: [{ name: "account", type: "address" }],
                    outputs: [{ name: "", type: "uint256" }],
                }],
                functionName: "balanceOf",
                args: [wallet.account.address],
            });
            console.log("USDC balance after:", usdcAfter.toString(), "(raw)");
            console.log("USDC gained (raw):", (usdcAfter - usdcBefore).toString());
        } else {
            const gained = Number(afterBalance - beforeBalance) / 1e18;
            console.log("ETH gained (approx):", gained.toFixed(6), "ETH (minus gas)");
        }
    } else {
        console.log("\nClaim failed. Check transaction on Sepolia explorer.");
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const phase = process.env.PHASE || "send";
    if (phase === "send") {
        await sendFromRome();
    } else if (phase === "claim") {
        await claimOnSepolia();
    } else {
        console.log("Unknown PHASE. Use PHASE=send or PHASE=claim.");
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
