/**
 * Inbound Wormhole transfer: Sepolia ETH → Rome EVM (wrapped WETH).
 *
 * Prerequisites:
 *   1. Sepolia ETH in your wallet (same private key for both networks)
 *   2. Solana devnet SOL on the EVM-derived payer keypair (for posting the VAA on Solana)
 *
 * Usage:
 *   # Step 1 — Lock ETH on Sepolia. Prints the sequence number for Step 2.
 *   PHASE=send npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network sepolia
 *
 *   # Step 2 — Claim on Rome. Polls Wormholescan, posts VAA, completes transfer.
 *   PHASE=claim SEQ=<sequence> npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network monti_spl
 *
 *   # Or supply the base64 VAA directly (skips polling):
 *   PHASE=claim VAA_B64=<base64> npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network monti_spl
 *
 * Environment:
 *   MONTI_SPL_PRIVATE_KEY  — hex private key (with 0x prefix)
 *   SEPOLIA_PRIVATE_KEY    — same key, used on Sepolia
 *   PHASE                  — "send" or "claim"
 *   SEQ                    — Wormhole sequence number (from Step 1 output)
 *   VAA_B64                — (optional) base64-encoded signed VAA
 *   SOLANA_RPC_URL         — (optional) Solana JSON-RPC for post_vaa / claim (default: public devnet)
 *   ROME_EVM_PROGRAM       — (optional) Rome EVM program id for PDA derivation (must match rollup)
 *   AMOUNT                 — (optional) ETH amount to send, default "0.001"
 *   USDC_ADDRESS           — (optional) Sepolia USDC contract (0x...). When set, sends ERC-20 via
 *                            transferTokens instead of wrapAndTransferETH. Use AMOUNT in token
 *                            units (e.g. 1 = 1 USDC if USDC_DECIMALS=6).
 *   USDC_DECIMALS          — (optional) default 6
 *
 * USDC end-to-end: PHASE=full in scripts/wormhole_usdc/inbound.ts (see README there).
 */
import hardhat from "hardhat";
import { isHardhatOrNodeEntry } from "./lib/helpers.js";
import {
    Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
    sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY, SystemProgram as SolanaSystemProgram,
} from "@solana/web3.js";
import { encodeFunctionData, parseEther, parseUnits } from "viem";
import { deserialize } from "@wormhole-foundation/sdk-connect";
import {
    publicKeyToBytes32Hex,
    solanaAccountMetasToRome,
    encodeRomeWormholeClaimCompleteWrapped,
} from "@wormhole-foundation/sdk-solana";
import { utils as coreUtils } from "@wormhole-foundation/sdk-solana-core";
import {
    deriveTokenBridgeConfigKey,
    deriveMintAuthorityKey,
    deriveWrappedMintKey,
    deriveWrappedMetaKey,
    deriveEndpointKey,
} from "@wormhole-foundation/sdk-solana-tokenbridge";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Sepolia
const SEPOLIA_TOKEN_BRIDGE = "0xDB5492265f6038831E89f495670FF909aDe94bd9";
const SEPOLIA_EMITTER = "000000000000000000000000db5492265f6038831e89f495670ff909ade94bd9";
const SEPOLIA_WORMHOLE_CHAIN_ID = 10002;
const SOLANA_CHAIN_ID = 1; // Wormhole chain ID for Solana

// Sepolia WETH (token address emitted by the Token Bridge)
const SEPOLIA_WETH_PADDED = Buffer.from(
    "000000000000000000000000eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c", "hex",
);

// Solana (default: public devnet; override with SOLANA_RPC_URL)
const SOLANA_RPC = process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";
const WORMHOLE_CORE = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
const TOKEN_BRIDGE = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const SPL_TOKEN_PK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Rome EVM
const ASSOC_TOKEN_PRECOMPILE = "0xFF00000000000000000000000000000000000006" as const;

/** Hardhat network names (override via env for CI / custom RPC profiles). */
export const SEPOLIA_NETWORK = process.env.SEPOLIA_NETWORK ?? "sepolia_env";
export const ROME_NETWORK = process.env.ROME_NETWORK ?? "monti_spl_env";

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

/** Left-pad EVM token address to 32 bytes (Wormhole foreign asset id). */
function padEvmTokenAddress(token: `0x${string}`): Buffer {
    return Buffer.from(token.replace(/^0x/i, "").padStart(64, "0"), "hex");
}

function getEvmPrivateKey(): string {
    const raw = process.env.MONTI_SPL_PRIVATE_KEY || process.env.SEPOLIA_PRIVATE_KEY || "";
    return raw.replace(/^0x/, "");
}

async function fetchSignedVaa(seq: number, maxWaitMs = 900_000): Promise<string> {
    const url = `${WORMHOLESCAN_API}/${SEPOLIA_WORMHOLE_CHAIN_ID}/${SEPOLIA_EMITTER}/${seq}`;
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
        } catch {}

        await new Promise(r => setTimeout(r, 15_000));
    }

    throw new Error(`VAA not found after ${maxWaitMs / 1000}s. Check Wormholescan manually.`);
}

// ---------------------------------------------------------------------------
// Phase 1: Send from Sepolia
// ---------------------------------------------------------------------------

export async function sendFromSepolia(): Promise<string | undefined> {
    const { viem } = await hardhat.network.connect({ network: SEPOLIA_NETWORK });
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    const usdcAddr = process.env.USDC_ADDRESS as `0x${string}` | undefined;
    const isUsdc = Boolean(usdcAddr && usdcAddr.startsWith("0x") && usdcAddr.length === 42);

    console.log(isUsdc ? "=== Phase 1: Send USDC from Sepolia ===" : "=== Phase 1: Send ETH from Sepolia ===");
    console.log("Wallet:", wallet.account.address);
    const balance = await publicClient.getBalance({ address: wallet.account.address });
    console.log("ETH Balance:", (Number(balance) / 1e18).toFixed(6), "ETH");

    const sendAmount = isUsdc
        ? parseUnits(process.env.AMOUNT || "1", Number(process.env.USDC_DECIMALS || "6"))
        : parseEther(process.env.AMOUNT || "0.001");

    if (!isUsdc && balance < sendAmount + parseEther("0.005")) {
        console.log("\nInsufficient ETH. Get Sepolia ETH from a faucet.");
        return undefined;
    }
    if (isUsdc && balance < parseEther("0.01")) {
        console.log("\nNeed a small amount of Sepolia ETH for gas + bridge fee. Fund the wallet.");
        return undefined;
    }

    // Derive PDA → wrapped mint → recipient ATA (bridge contract lives on Rome, not Sepolia).
    // Seeds: ["EXTERNAL_AUTHORITY", <20-byte EVM address>], program: Rome EVM program ID
    // Must match RomeEVMAccount.pda() in contracts/rome_evm_account.sol
    // The program ID must be the actual deployed Rome EVM program for the target rollup.
    const ROME_EVM_PROGRAM = new PublicKey(process.env.ROME_EVM_PROGRAM || "DP1dshBzmXXVsRxH5kCKMemrDuptg1JvJ1j5AsFV4Hm3");
    const pda = PublicKey.findProgramAddressSync(
        [Buffer.from("EXTERNAL_AUTHORITY"), Buffer.from(wallet.account.address.slice(2), "hex")],
        ROME_EVM_PROGRAM,
    )[0];
    console.log("Rome PDA:", pda.toBase58());

    const foreignAsset = isUsdc ? padEvmTokenAddress(usdcAddr!) : SEPOLIA_WETH_PADDED;
    const wrappedMint = deriveWrappedMintKey(TOKEN_BRIDGE, SEPOLIA_WORMHOLE_CHAIN_ID, foreignAsset);
    const recipientAta = getAta(wrappedMint, pda);
    const recipientAtaHex = `0x${Buffer.from(recipientAta.toBytes()).toString("hex")}` as `0x${string}`;

    console.log("Wrapped mint:", wrappedMint.toBase58());
    console.log("Recipient ATA:", recipientAta.toBase58());

    const feeWei = BigInt(process.env.WORMHOLE_FEE_WEI || "0");

    let txHash: `0x${string}`;

    if (isUsdc) {
        console.log(`\nSending ${process.env.AMOUNT || "1"} USDC (raw ${sendAmount}) via Token Bridge...`);
        const allowance = await publicClient.readContract({
            address: usdcAddr!,
            abi: [{
                name: "allowance",
                type: "function",
                stateMutability: "view",
                inputs: [
                    { name: "owner", type: "address" },
                    { name: "spender", type: "address" },
                ],
                outputs: [{ name: "", type: "uint256" }],
            }],
            functionName: "allowance",
            args: [wallet.account.address, SEPOLIA_TOKEN_BRIDGE as `0x${string}`],
        });
        if (allowance < sendAmount) {
            const approveHash = await wallet.writeContract({
                address: usdcAddr!,
                abi: [{
                    name: "approve",
                    type: "function",
                    stateMutability: "nonpayable",
                    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
                    outputs: [{ name: "", type: "bool" }],
                }],
                functionName: "approve",
                args: [SEPOLIA_TOKEN_BRIDGE as `0x${string}`, sendAmount],
            });
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
            console.log("Approve TX:", approveHash);
        }

        txHash = await wallet.writeContract({
            address: SEPOLIA_TOKEN_BRIDGE as `0x${string}`,
            abi: [{
                name: "transferTokens",
                type: "function",
                stateMutability: "payable",
                inputs: [
                    { name: "token", type: "address" },
                    { name: "amount", type: "uint256" },
                    { name: "recipientChain", type: "uint16" },
                    { name: "recipient", type: "bytes32" },
                    { name: "arbiterFee", type: "uint256" },
                    { name: "nonce", type: "uint32" },
                ],
                outputs: [{ name: "sequence", type: "uint64" }],
            }],
            functionName: "transferTokens",
            args: [usdcAddr!, sendAmount, SOLANA_CHAIN_ID, recipientAtaHex, 0n, 0],
            value: feeWei,
            gas: 800_000n,
        });
    } else {
        console.log(`\nSending ${Number(sendAmount) / 1e18} ETH to Wormhole Token Bridge...`);

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
            args: [SOLANA_CHAIN_ID, recipientAtaHex, 0n, 0],
        });

        txHash = await wallet.sendTransaction({
            to: SEPOLIA_TOKEN_BRIDGE as `0x${string}`,
            data: calldata,
            value: sendAmount,
            gas: 500_000n,
        });
    }
    console.log("TX:", txHash);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("Status:", receipt.status);
    console.log("Block:", receipt.blockNumber.toString());

    // Parse sequence from LogMessagePublished event data (not topics).
    // Event: LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)
    // topics[0] = event sig, topics[1] = indexed sender. sequence is the first field in data.
    const wormholeLog = receipt.logs.find(
        l => l.topics[0] === "0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2",
    );
    const seq = wormholeLog ? BigInt("0x" + wormholeLog.data.slice(2, 66)).toString() : "unknown";

    console.log("\n=== Step 1 complete ===");
    console.log("Sequence:", seq);
    console.log("\nRun Step 2 (~15 min after guardians sign):");
    console.log(`  PHASE=claim SEQ=${seq} npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network ${ROME_NETWORK}`);
    return seq;
}

// ---------------------------------------------------------------------------
// Phase 2: Claim on Rome
// ---------------------------------------------------------------------------

export async function claimOnRome(): Promise<void> {
    // -----------------------------------------------------------------------
    // 1. Get the signed VAA
    // -----------------------------------------------------------------------
    let vaaB64: string;

    if (process.env.VAA_B64) {
        vaaB64 = process.env.VAA_B64;
        console.log("Using VAA from VAA_B64 env var.");
    } else if (process.env.SEQ) {
        const seq = parseInt(process.env.SEQ, 10);
        console.log(`Fetching signed VAA for sequence ${seq}...`);
        vaaB64 = await fetchSignedVaa(seq);
    } else {
        throw new Error("Provide SEQ=<sequence> or VAA_B64=<base64>. SEQ comes from Phase 1 output.");
    }

    const vaaBytes = Buffer.from(vaaB64, "base64");
    const vaa = deserialize("TokenBridge:Transfer", vaaBytes) as any;

    const { viem } = await hardhat.network.connect({ network: ROME_NETWORK });

    console.log("\n=== Phase 2: Claim on Rome ===");
    console.log("  Sequence:", vaa.sequence?.toString());
    console.log("  Emitter:", vaa.emitterChain);
    console.log("  Hash:", Buffer.from(vaa.hash).toString("hex"));

    // Extract token + emitter info from raw VAA
    const sigCount = vaaBytes[5];
    const bodyOffset = 6 + sigCount * 66;
    const payload = vaaBytes.subarray(bodyOffset + 51);
    const tokenAddress = payload.subarray(33, 65);
    const tokenChain = payload.readUInt16BE(65);
    const emitterAddress = vaaBytes.subarray(bodyOffset + 10, bodyOffset + 42);
    const emitterChain = vaaBytes.readUInt16BE(bodyOffset + 8);
    const sequence = vaaBytes.readBigUInt64BE(bodyOffset + 42);

    // -----------------------------------------------------------------------
    // 2. Post VAA to Solana devnet
    // -----------------------------------------------------------------------
    console.log("\n--- Step 1: Post VAA to Solana devnet ---");
    console.log("Solana RPC:", SOLANA_RPC);

    const connection = new Connection(SOLANA_RPC, "confirmed");
    const vaaHash = Buffer.from(vaa.hash);
    const postedVaaKey = coreUtils.derivePostedVaaKey(WORMHOLE_CORE, vaaHash);

    const postedVaaInfo = await connection.getAccountInfo(postedVaaKey);
    if (postedVaaInfo) {
        console.log("PostedVAA already exists. Skipping.");
    } else {
        const evmKey = getEvmPrivateKey();
        const payer = Keypair.fromSeed(Buffer.from(evmKey, "hex"));
        console.log("Solana payer:", payer.publicKey.toBase58());

        let solBalance = await connection.getBalance(payer.publicKey);
        console.log("Payer balance:", solBalance / 1e9, "SOL");

        if (solBalance < 10_000_000) {
            console.log("Funding payer from Rome EVM...");
            const [romeWallet] = await viem.getWalletClients();
            const romePublic = await viem.getPublicClient();
            if (!romeWallet?.account) throw new Error("No Rome wallet");

            const SYSTEM_PRECOMPILE = "0xfF00000000000000000000000000000000000007" as const;
            const payerBytes32 = `0x${Buffer.from(payer.publicKey.toBytes()).toString("hex")}` as `0x${string}`;

            const fundTx = await romeWallet.sendTransaction({
                to: SYSTEM_PRECOMPILE,
                data: encodeFunctionData({
                    abi: [{
                        name: "transfer", type: "function" as const, stateMutability: "nonpayable" as const,
                        inputs: [
                            { name: "to", type: "bytes32" as const },
                            { name: "amount", type: "uint64" as const },
                            { name: "salt", type: "bytes32" as const },
                        ],
                        outputs: [] as const,
                    }],
                    functionName: "transfer",
                    args: [payerBytes32, BigInt(100_000_000), "0x0000000000000000000000000000000000000000000000000000000000000001"],
                }),
                gas: 5_000_000n,
            });
            await romePublic.waitForTransactionReceipt({ hash: fundTx });
            solBalance = await connection.getBalance(payer.publicKey);
            console.log("Payer balance after funding:", solBalance / 1e9, "SOL");
        }

        const signatureSet = Keypair.generate();
        const verifyIxs = await coreUtils.createVerifySignaturesInstructions(
            connection, WORMHOLE_CORE, payer.publicKey, vaa, signatureSet.publicKey,
        );

        for (let i = 0; i < verifyIxs.length; i += 2) {
            const tx = new Transaction().add(...verifyIxs.slice(i, i + 2));
            tx.feePayer = payer.publicKey;
            const sig = await sendAndConfirmTransaction(connection, tx, [payer, signatureSet]);
            console.log(`  verify_signatures ${i / 2 + 1}:`, sig);
        }

        const postTx = new Transaction().add(
            coreUtils.createPostVaaInstruction(connection, WORMHOLE_CORE, payer.publicKey, vaa, signatureSet.publicKey),
        );
        postTx.feePayer = payer.publicKey;
        const postSig = await sendAndConfirmTransaction(connection, postTx, [payer]);
        console.log("  post_vaa:", postSig);
    }

    // -----------------------------------------------------------------------
    // 3. Rome EVM user PDA (derive locally — avoids eth_call to RomeWormholeBridge, which uses
    //    Rome's internal Solana RPC and can 502 when that backend is unhealthy).
    // -----------------------------------------------------------------------
    console.log("\n--- Step 2: Rome EVM user PDA ---");
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");
    console.log("Wallet:", wallet.account.address);

    const ROME_EVM_PROGRAM = new PublicKey(process.env.ROME_EVM_PROGRAM || "DP1dshBzmXXVsRxH5kCKMemrDuptg1JvJ1j5AsFV4Hm3");
    const pda = PublicKey.findProgramAddressSync(
        [Buffer.from("EXTERNAL_AUTHORITY"), Buffer.from(wallet.account.address.slice(2), "hex")],
        ROME_EVM_PROGRAM,
    )[0];
    console.log("PDA:", pda.toBase58());

    // -----------------------------------------------------------------------
    // 4. Derive wrapped mint + ensure ATA exists
    // -----------------------------------------------------------------------
    console.log("\n--- Step 3: Wrapped mint + ATA ---");
    const wrappedMint = deriveWrappedMintKey(TOKEN_BRIDGE, tokenChain, tokenAddress);
    const recipientAta = getAta(wrappedMint, pda);
    console.log("Wrapped mint:", wrappedMint.toBase58());
    console.log("ATA:", recipientAta.toBase58());

    const ataInfo = await connection.getAccountInfo(recipientAta);
    if (ataInfo) {
        console.log("ATA exists.");
    } else {
        console.log("Creating ATA...");
        const mintHex = publicKeyToBytes32Hex(wrappedMint);
        const ataTx = await wallet.sendTransaction({
            to: ASSOC_TOKEN_PRECOMPILE,
            data: encodeFunctionData({
                abi: [{
                    name: "create_associated_token_account", type: "function" as const,
                    stateMutability: "nonpayable" as const,
                    inputs: [{ name: "user", type: "address" as const }, { name: "mint", type: "bytes32" as const }],
                    outputs: [] as const,
                }],
                functionName: "create_associated_token_account",
                args: [wallet.account.address, mintHex as `0x${string}`],
            }),
            gas: 5_000_000n,
        });
        await publicClient.waitForTransactionReceipt({ hash: ataTx });
        console.log("ATA created:", ataTx);
    }

    // -----------------------------------------------------------------------
    // 5. claimCompleteWrapped — send as native Solana transaction
    //    (bypasses Rome EVM proxy emulator which can't simulate complex CPI)
    // -----------------------------------------------------------------------
    console.log("\n--- Step 4: claimCompleteWrapped (native Solana) ---");

    const evmKey = getEvmPrivateKey();
    const payer = Keypair.fromSeed(Buffer.from(evmKey, "hex"));

    const claimIx = new TransactionInstruction({
        programId: TOKEN_BRIDGE,
        keys: [
            { pubkey: payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: deriveTokenBridgeConfigKey(TOKEN_BRIDGE), isSigner: false, isWritable: false },
            { pubkey: postedVaaKey, isSigner: false, isWritable: false },
            { pubkey: coreUtils.deriveClaimKey(TOKEN_BRIDGE, emitterAddress, emitterChain, sequence), isSigner: false, isWritable: true },
            { pubkey: deriveEndpointKey(TOKEN_BRIDGE, emitterChain, emitterAddress), isSigner: false, isWritable: false },
            { pubkey: recipientAta, isSigner: false, isWritable: true },
            { pubkey: recipientAta, isSigner: false, isWritable: true }, // toFees = same when fee=0
            { pubkey: wrappedMint, isSigner: false, isWritable: true },
            { pubkey: deriveWrappedMetaKey(TOKEN_BRIDGE, wrappedMint), isSigner: false, isWritable: false },
            { pubkey: deriveMintAuthorityKey(TOKEN_BRIDGE), isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: SolanaSystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: SPL_TOKEN_PK, isSigner: false, isWritable: false },
            { pubkey: WORMHOLE_CORE, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([3]), // CompleteWrapped instruction discriminator
    });

    const claimTx = new Transaction().add(claimIx);
    claimTx.feePayer = payer.publicKey;
    const claimSig = await sendAndConfirmTransaction(connection, claimTx, [payer]);
    console.log("Claim TX:", claimSig);

    // Verify balance
    const ataData = await connection.getAccountInfo(recipientAta);
    if (ataData && ataData.data.length >= 72) {
        const balance = ataData.data.readBigUInt64LE(64);
        console.log("\n=== SUCCESS ===");
        console.log("Wrapped tokens minted to ATA:", recipientAta.toBase58());
        console.log("Mint:", wrappedMint.toBase58());
        console.log("ATA balance (raw smallest units):", balance.toString());
    } else {
        console.log("Could not read ATA balance.");
    }
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

if (isHardhatOrNodeEntry(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
