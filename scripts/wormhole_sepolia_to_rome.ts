/**
 * Inbound Wormhole transfer: Sepolia ETH → Rome EVM (wrapped WETH).
 *
 * Prerequisites:
 *   1. RomeWormholeBridge deployed (scripts/deploy_wormhole_bridge.ts)
 *   2. Sepolia ETH in your wallet (same private key for both networks)
 *   3. SOL in your Rome PDA on Solana devnet (for posting the VAA)
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
 *   BRIDGE                 — (optional) RomeWormholeBridge address override
 *   AMOUNT                 — (optional) ETH amount to send, default "0.001"
 */
import hardhat from "hardhat";
import {
    Connection, Keypair, PublicKey, Transaction,
    sendAndConfirmTransaction, SYSVAR_RENT_PUBKEY, SystemProgram as SolanaSystemProgram,
} from "@solana/web3.js";
import { encodeFunctionData, parseEther } from "viem";
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

// Solana Devnet
const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
const WORMHOLE_CORE = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
const TOKEN_BRIDGE = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const SPL_TOKEN_PK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Rome EVM
const DEFAULT_BRIDGE = "0x79f34fa78651efa9d24ff8ac526cbd9753e8fc1f";
const ASSOC_TOKEN_PRECOMPILE = "0xFF00000000000000000000000000000000000006" as const;

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

async function sendFromSepolia() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    console.log("=== Phase 1: Send ETH from Sepolia ===");
    console.log("Wallet:", wallet.account.address);
    const balance = await publicClient.getBalance({ address: wallet.account.address });
    console.log("ETH Balance:", (Number(balance) / 1e18).toFixed(6), "ETH");

    const sendAmount = parseEther(process.env.AMOUNT || "0.001");
    if (balance < sendAmount + parseEther("0.005")) {
        console.log("\nInsufficient ETH. Get Sepolia ETH from a faucet.");
        return;
    }

    // Derive PDA → wrapped mint → ATA
    const evmKey = getEvmPrivateKey();
    const payer = Keypair.fromSeed(Buffer.from(evmKey, "hex"));
    const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");

    const bridgeAddr = process.env.BRIDGE || DEFAULT_BRIDGE;
    const bridgeContract = await viem.getContractAt("RomeWormholeBridge", bridgeAddr);
    // PDA must be derived for the *same* wallet on Rome EVM, which uses the same key
    const pdaHex = await bridgeContract.read.bridgeUserPda() as `0x${string}`;
    const pda = new PublicKey(Buffer.from(pdaHex.slice(2), "hex"));
    console.log("Rome PDA:", pda.toBase58());

    const wrappedMint = deriveWrappedMintKey(TOKEN_BRIDGE, SEPOLIA_WORMHOLE_CHAIN_ID, SEPOLIA_WETH_PADDED);
    const recipientAta = getAta(wrappedMint, pda);
    const recipientAtaHex = `0x${Buffer.from(recipientAta.toBytes()).toString("hex")}` as `0x${string}`;

    console.log("Wrapped mint:", wrappedMint.toBase58());
    console.log("Recipient ATA:", recipientAta.toBase58());

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

    const txHash = await wallet.sendTransaction({
        to: SEPOLIA_TOKEN_BRIDGE as `0x${string}`,
        data: calldata,
        value: sendAmount,
        gas: 500_000n,
    });
    console.log("TX:", txHash);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("Status:", receipt.status);
    console.log("Block:", receipt.blockNumber.toString());

    // Parse sequence from logs (topic[1] of the LogMessagePublished event)
    const wormholeLog = receipt.logs.find(
        l => l.topics[0] === "0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2",
    );
    const seq = wormholeLog ? BigInt(wormholeLog.topics[1]!).toString() : "unknown";

    console.log("\n=== Step 1 complete ===");
    console.log("Sequence:", seq);
    console.log("\nRun Step 2 (~15 min after guardians sign):");
    console.log(`  PHASE=claim SEQ=${seq} npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network monti_spl`);
}

// ---------------------------------------------------------------------------
// Phase 2: Claim on Rome
// ---------------------------------------------------------------------------

async function claimOnRome() {
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

    const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");
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
            const { viem: romeViem } = await hardhat.network.connect();
            const [romeWallet] = await romeViem.getWalletClients();
            const romePublic = await romeViem.getPublicClient();
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
    // 3. Connect to Rome EVM
    // -----------------------------------------------------------------------
    console.log("\n--- Step 2: Connect to Rome EVM ---");
    const bridgeAddr = process.env.BRIDGE || DEFAULT_BRIDGE;

    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    const bridge = await viem.getContractAt("RomeWormholeBridge", bridgeAddr);
    console.log("Wallet:", wallet.account.address);

    const pdaHex = await bridge.read.bridgeUserPda() as `0x${string}`;
    const pda = new PublicKey(Buffer.from(pdaHex.slice(2), "hex"));
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
    // 5. claimCompleteWrapped
    // -----------------------------------------------------------------------
    console.log("\n--- Step 4: claimCompleteWrapped ---");
    const claimAccounts = [
        { pubkey: pda, isSigner: true, isWritable: true },
        { pubkey: deriveTokenBridgeConfigKey(TOKEN_BRIDGE), isSigner: false, isWritable: false },
        { pubkey: postedVaaKey, isSigner: false, isWritable: false },
        { pubkey: coreUtils.deriveClaimKey(TOKEN_BRIDGE, emitterAddress, emitterChain, sequence), isSigner: false, isWritable: true },
        { pubkey: deriveEndpointKey(TOKEN_BRIDGE, emitterChain, emitterAddress), isSigner: false, isWritable: false },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: wrappedMint, isSigner: false, isWritable: true },
        { pubkey: deriveWrappedMetaKey(TOKEN_BRIDGE, wrappedMint), isSigner: false, isWritable: false },
        { pubkey: deriveMintAuthorityKey(TOKEN_BRIDGE), isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SolanaSystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SPL_TOKEN_PK, isSigner: false, isWritable: false },
        { pubkey: WORMHOLE_CORE, isSigner: false, isWritable: false },
    ];

    const claimCalldata = encodeRomeWormholeClaimCompleteWrapped(
        publicKeyToBytes32Hex(TOKEN_BRIDGE),
        solanaAccountMetasToRome(claimAccounts),
    );

    const claimTxHash = await wallet.sendTransaction({
        to: bridgeAddr as `0x${string}`,
        data: claimCalldata,
        gas: 5_000_000n,
    });
    const claimReceipt = await publicClient.waitForTransactionReceipt({ hash: claimTxHash });
    console.log("TX:", claimTxHash);
    console.log("Status:", claimReceipt.status);

    if (claimReceipt.status === "success") {
        console.log("\n=== SUCCESS ===");
        console.log("Wrapped tokens minted to ATA:", recipientAta.toBase58());
        console.log("Mint:", wrappedMint.toBase58());

        // Read balance
        const ataData = await connection.getAccountInfo(recipientAta);
        if (ataData && ataData.data.length >= 72) {
            const balance = ataData.data.readBigUInt64LE(64);
            console.log("ATA balance:", balance.toString(), `(${Number(balance) / 1e8} WETH)`);
        }
    } else {
        console.log("\nTransaction reverted.");
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

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
