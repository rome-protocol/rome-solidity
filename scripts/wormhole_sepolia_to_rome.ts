/**
 * Bridge tokens from Sepolia → Rome EVM via Wormhole.
 *
 * Two phases:
 *   Phase 1 (Sepolia):  Lock tokens on Sepolia Token Bridge → get VAA
 *   Phase 2 (Rome):     Post VAA on Solana devnet + claimCompleteWrapped on Rome EVM
 *
 * Usage:
 *   # Phase 1: Send from Sepolia (wraps & locks ETH)
 *   PHASE=send npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network sepolia
 *
 *   # Phase 2: Claim on Rome (after VAA is available)
 *   PHASE=claim npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network monti_spl
 *
 *   # Or provide a custom VAA:
 *   PHASE=claim VAA_B64=<base64> npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network monti_spl
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

// Sepolia (Ethereum testnet)
const SEPOLIA_TOKEN_BRIDGE = "0xDB5492265f6038831E89f495670FF909aDe94bd9";
const SOLANA_CHAIN_ID = 1;

// Solana Devnet — same cluster Rome EVM runs on
const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
const WORMHOLE_CORE = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
const TOKEN_BRIDGE = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const SPL_TOKEN_PK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Rome EVM — deployed RomeWormholeBridge contract
const BRIDGE_ADDRESS = "0x79f34fa78651efa9d24ff8ac526cbd9753e8fc1f";

// Rome EVM precompile addresses
const ASSOC_TOKEN_PRECOMPILE = "0xFF00000000000000000000000000000000000006" as const;

// Default VAA from the corrected Sepolia transfer (sequence 343846, recipient = ATA)
const DEFAULT_VAA_B64 =
    "AQAAAAABAOIx5K7OeRBbDJNJpiY8mGzPrAA9KlrmLPKG0FoJkZofbE4dHI81sjYHEOtb8dcRO1sTVMXx2kqcMJDevVTinbABadQFUAAAAAAnEgAAAAAAAAAAAAAAANtUkiZfYDiDHon0lWcP+Qmt6UvZAAAAAAAFPyYBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYagAAAAAAAAAAAAAAAA7vEqg+5bcWHThzMXyODnt24LXZwnEiw4QaLvURhcFpb3j+Feg6pV/mvLuEMjniy+b/GfWc68AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

// EVM private key (used to derive a Solana keypair for posting the VAA)
const EVM_PRIVATE_KEY = "fff86a5d88cc029df8c309c0bc77144ce8f21dfdcc85fc965b16dd1cba442ad8";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAta(mint: PublicKey, owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), SPL_TOKEN_PK.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM,
    )[0];
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
    console.log("ETH Balance:", balance.toString(), `(${Number(balance) / 1e18} ETH)`);

    if (balance < parseEther("0.01")) {
        console.log("\nInsufficient ETH. Get Sepolia ETH from a faucet.");
        return;
    }

    // The PDA (Rome EVM wallet's canonical Solana identity)
    const pda = new PublicKey(Buffer.from(
        "1f8d99b0be76e3e279322fb00689009cf921507c8210041ed6f6d2732b2d5ce0", "hex",
    ));
    console.log("\nRome PDA:", pda.toBase58());

    // The Wormhole Token Bridge on Solana requires the recipient to be a TOKEN
    // ACCOUNT (ATA), not a wallet address. The Token Bridge checks that the `to`
    // account key in the instruction matches the `recipient` bytes in the VAA.
    //
    // To compute the ATA, we need the wrapped mint, which is derived from the
    // token chain + token address that the Sepolia Token Bridge will emit.
    // For wrapAndTransferETH on Sepolia:
    //   token_chain = 10002 (Sepolia)
    //   token_address = Sepolia WETH contract (left-padded to 32 bytes)
    //
    // We extract these from the previous VAA to ensure consistency.
    const SEPOLIA_WETH_PADDED = Buffer.from(
        "000000000000000000000000eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c", "hex",
    );
    const SEPOLIA_CHAIN_ID_WORMHOLE = 10002;

    const wrappedMint = deriveWrappedMintKey(
        TOKEN_BRIDGE,
        SEPOLIA_CHAIN_ID_WORMHOLE,
        SEPOLIA_WETH_PADDED,
    );
    console.log("Wrapped mint (Solana):", wrappedMint.toBase58());

    const recipientAta = getAta(wrappedMint, pda);
    console.log("Recipient ATA:", recipientAta.toBase58());

    const recipientAtaHex = `0x${Buffer.from(recipientAta.toBytes()).toString("hex")}` as `0x${string}`;
    console.log("Recipient ATA (hex):", recipientAtaHex);

    const SEND_AMOUNT = parseEther("0.001");

    console.log(`\nSending ${Number(SEND_AMOUNT) / 1e18} ETH to Wormhole Token Bridge...`);
    console.log("Token Bridge:", SEPOLIA_TOKEN_BRIDGE);

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

        console.log("\n=== Next Steps ===");
        console.log("1. Wait ~15 minutes for guardians to sign the VAA");
        console.log("2. Fetch the signed VAA from Wormholescan API");
        console.log("3. Then run Phase 2:");
        console.log("   PHASE=claim npx hardhat run scripts/wormhole_sepolia_to_rome.ts --network monti_spl");
    } catch (e: any) {
        console.log("TX failed:", e.message?.slice(0, 300));
    }
}

// ---------------------------------------------------------------------------
// Phase 2: Claim on Rome
// ---------------------------------------------------------------------------

async function claimOnRome() {
    // -----------------------------------------------------------------------
    // 1. Parse the VAA
    // -----------------------------------------------------------------------
    const vaaB64 = process.env.VAA_B64 || DEFAULT_VAA_B64;
    const vaaBytes = Buffer.from(vaaB64, "base64");
    const vaa = deserialize("TokenBridge:Transfer", vaaBytes) as any;

    console.log("=== Phase 2: Claim on Rome ===");
    console.log("VAA parsed:");
    console.log("  Guardian set:", vaa.guardianSet);
    console.log("  Emitter chain:", vaa.emitterChain);
    console.log("  Sequence:", vaa.sequence?.toString());
    console.log("  Hash:", Buffer.from(vaa.hash).toString("hex"));
    console.log("  Token chain:", vaa.payload?.token?.chain);
    console.log("  Amount:", vaa.payload?.token ? "present" : "missing");

    // Extract token info from VAA for PDA derivation
    const rawVaaBuf = vaaBytes;
    const sigCount = rawVaaBuf[5];
    const bodyOffset = 6 + sigCount * 66;
    const payload = rawVaaBuf.subarray(bodyOffset + 51);
    const tokenAddress = payload.subarray(33, 65);
    const tokenChain = payload.readUInt16BE(65);
    const emitterAddress = rawVaaBuf.subarray(bodyOffset + 10, bodyOffset + 42);
    const emitterChain = rawVaaBuf.readUInt16BE(bodyOffset + 8);
    const sequence = rawVaaBuf.readBigUInt64BE(bodyOffset + 42);

    console.log("\n  Token address:", "0x" + tokenAddress.toString("hex"));
    console.log("  Token chain ID:", tokenChain);
    console.log("  Emitter:", "0x" + emitterAddress.toString("hex"));

    // -----------------------------------------------------------------------
    // 2. Post VAA to Solana devnet (native Solana transactions)
    // -----------------------------------------------------------------------
    console.log("\n--- Step 1: Post VAA to Solana devnet ---");

    const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");
    const vaaHash = Buffer.from(vaa.hash);
    const postedVaaKey = coreUtils.derivePostedVaaKey(WORMHOLE_CORE, vaaHash);
    console.log("PostedVAA PDA:", postedVaaKey.toBase58());

    const postedVaaInfo = await connection.getAccountInfo(postedVaaKey);

    if (postedVaaInfo) {
        console.log("PostedVAA already exists on Solana! Skipping verify+post.");
    } else {
        console.log("PostedVAA not found. Posting via native Solana transactions...");

        // Derive a Solana keypair from the EVM private key for paying tx fees
        const payer = Keypair.fromSeed(Buffer.from(EVM_PRIVATE_KEY, "hex"));
        console.log("Solana payer:", payer.publicKey.toBase58());

        let solBalance = await connection.getBalance(payer.publicKey);
        console.log("Payer balance:", solBalance / 1e9, "SOL");

        if (solBalance < 10_000_000) {
            console.log("Payer needs SOL. Funding from Rome EVM via SystemProgram.transfer...");

            // Connect to Rome EVM to transfer SOL
            const { viem: romeViem } = await hardhat.network.connect();
            const [romeWallet] = await romeViem.getWalletClients();
            const romePublic = await romeViem.getPublicClient();
            if (!romeWallet?.account) throw new Error("No Rome wallet");

            const SYSTEM_PRECOMPILE = "0xfF00000000000000000000000000000000000007" as const;
            const payerBytes32 = `0x${Buffer.from(payer.publicKey.toBytes()).toString("hex")}` as `0x${string}`;
            const fundAmount = BigInt(100_000_000); // 0.1 SOL in lamports

            const fundCalldata = encodeFunctionData({
                abi: [{
                    name: "transfer",
                    type: "function" as const,
                    stateMutability: "nonpayable" as const,
                    inputs: [
                        { name: "to", type: "bytes32" as const },
                        { name: "amount", type: "uint64" as const },
                        { name: "salt", type: "bytes32" as const },
                    ],
                    outputs: [] as const,
                }],
                functionName: "transfer",
                args: [
                    payerBytes32,
                    fundAmount,
                    "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`,
                ],
            });

            try {
                const fundTx = await romeWallet.sendTransaction({
                    to: SYSTEM_PRECOMPILE,
                    data: fundCalldata,
                    gas: 5_000_000n,
                });
                const fundReceipt = await romePublic.waitForTransactionReceipt({ hash: fundTx });
                console.log("Fund payer tx:", fundTx, "status:", fundReceipt.status);
            } catch (e: any) {
                console.error("Funding failed:", e.message?.slice(0, 300));
                console.log("\nTrying airdrop as fallback...");
                try {
                    const sig = await connection.requestAirdrop(payer.publicKey, 1_000_000_000);
                    await connection.confirmTransaction(sig, "confirmed");
                    console.log("Airdrop confirmed:", sig);
                } catch (e2: any) {
                    console.error("Airdrop also failed:", e2.message?.slice(0, 200));
                    console.log("\nManual funding required. Send SOL to:", payer.publicKey.toBase58());
                    return;
                }
            }

            // Re-check balance
            solBalance = await connection.getBalance(payer.publicKey);
            console.log("Payer balance after funding:", solBalance / 1e9, "SOL");
            if (solBalance < 5_000_000) {
                console.error("Still insufficient SOL. Manual funding required.");
                return;
            }
        }

        // Verify guardian signatures (batched, each batch = Secp256k1 + verify_signatures)
        const signatureSet = Keypair.generate();
        console.log("\nCreating verify_signatures instructions...");

        const verifyIxs = await coreUtils.createVerifySignaturesInstructions(
            connection,
            WORMHOLE_CORE,
            payer.publicKey,
            vaa,
            signatureSet.publicKey,
        );

        console.log(`Built ${verifyIxs.length} instructions (${Math.ceil(verifyIxs.length / 2)} transactions)`);

        for (let i = 0; i < verifyIxs.length; i += 2) {
            const batch = verifyIxs.slice(i, i + 2);
            const tx = new Transaction().add(...batch);
            tx.feePayer = payer.publicKey;
            const sig = await sendAndConfirmTransaction(connection, tx, [payer, signatureSet]);
            console.log(`  verify_signatures tx ${i / 2 + 1}:`, sig);
        }

        // Post the VAA body
        console.log("Posting VAA...");
        const postVaaIx = coreUtils.createPostVaaInstruction(
            connection,
            WORMHOLE_CORE,
            payer.publicKey,
            vaa,
            signatureSet.publicKey,
        );

        const postVaaTx = new Transaction().add(postVaaIx);
        postVaaTx.feePayer = payer.publicKey;
        const postSig = await sendAndConfirmTransaction(connection, postVaaTx, [payer]);
        console.log("  post_vaa tx:", postSig);

        // Verify it's posted
        const check = await connection.getAccountInfo(postedVaaKey);
        if (check) {
            console.log("PostedVAA confirmed on Solana!");
        } else {
            console.error("PostedVAA NOT found after posting. Something went wrong.");
            return;
        }
    }

    // -----------------------------------------------------------------------
    // 3. Connect to Rome EVM
    // -----------------------------------------------------------------------
    console.log("\n--- Step 2: Connect to Rome EVM ---");

    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    const bridge = await viem.getContractAt("RomeWormholeBridge", BRIDGE_ADDRESS);

    console.log("Wallet:", wallet.account.address);

    const pdaHex = await bridge.read.bridgeUserPda() as `0x${string}`;
    const pda = new PublicKey(Buffer.from(pdaHex.slice(2), "hex"));
    console.log("Your PDA:", pda.toBase58());

    // -----------------------------------------------------------------------
    // 4. Derive wrapped mint and create ATA
    // -----------------------------------------------------------------------
    console.log("\n--- Step 3: Derive wrapped mint + create ATA ---");

    const wrappedMint = deriveWrappedMintKey(TOKEN_BRIDGE, tokenChain, tokenAddress);
    console.log("Wrapped mint:", wrappedMint.toBase58());

    const recipientAta = getAta(wrappedMint, pda);
    console.log("Recipient ATA:", recipientAta.toBase58());

    // Check if ATA exists on Solana
    const ataInfo = await connection.getAccountInfo(recipientAta);
    if (ataInfo) {
        console.log("ATA already exists!");
    } else {
        console.log("Creating ATA via Rome EVM precompile...");

        const mintHex = publicKeyToBytes32Hex(wrappedMint);
        const assocTokenAbi = [{
            name: "create_associated_token_account",
            type: "function" as const,
            stateMutability: "nonpayable" as const,
            inputs: [
                { name: "user", type: "address" as const },
                { name: "mint", type: "bytes32" as const },
            ],
            outputs: [] as const,
        }] as const;

        const ataCalldata = encodeFunctionData({
            abi: assocTokenAbi,
            functionName: "create_associated_token_account",
            args: [wallet.account.address, mintHex as `0x${string}`],
        });

        try {
            const ataTxHash = await wallet.sendTransaction({
                to: ASSOC_TOKEN_PRECOMPILE,
                data: ataCalldata,
                gas: 5_000_000n,
            });
            const ataReceipt = await publicClient.waitForTransactionReceipt({ hash: ataTxHash });
            console.log("ATA creation tx:", ataTxHash, "status:", ataReceipt.status);
        } catch (e: any) {
            console.log("ATA creation failed (may already exist):", e.message?.slice(0, 200));
        }
    }

    // -----------------------------------------------------------------------
    // 5. Call claimCompleteWrapped via RomeWormholeBridge
    // -----------------------------------------------------------------------
    console.log("\n--- Step 4: claimCompleteWrapped ---");

    // Build the account list matching Token Bridge completeWrapped instruction
    const claimKey = coreUtils.deriveClaimKey(
        TOKEN_BRIDGE,
        emitterAddress,
        emitterChain,
        sequence,
    );

    const endpointKey = deriveEndpointKey(TOKEN_BRIDGE, emitterChain, emitterAddress);

    const claimAccounts = [
        { pubkey: pda, isSigner: true, isWritable: true },
        { pubkey: deriveTokenBridgeConfigKey(TOKEN_BRIDGE), isSigner: false, isWritable: false },
        { pubkey: postedVaaKey, isSigner: false, isWritable: false },
        { pubkey: claimKey, isSigner: false, isWritable: true },
        { pubkey: endpointKey, isSigner: false, isWritable: false },
        { pubkey: recipientAta, isSigner: false, isWritable: true },
        { pubkey: recipientAta, isSigner: false, isWritable: true }, // toFees = to
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

    console.log(`Claim accounts: ${claimAccounts.length}`);
    console.log(`Calldata length: ${(claimCalldata.length - 2) / 2} bytes`);
    console.log(`Calldata: ${claimCalldata.slice(0, 74)}...`);

    console.log("\nSubmitting claimCompleteWrapped transaction...");
    try {
        const claimTxHash = await wallet.sendTransaction({
            to: BRIDGE_ADDRESS as `0x${string}`,
            data: claimCalldata,
            gas: 5_000_000n,
        });
        console.log("TX submitted:", claimTxHash);

        const claimReceipt = await publicClient.waitForTransactionReceipt({ hash: claimTxHash });
        console.log("Status:", claimReceipt.status);

        if (claimReceipt.status === "success") {
            console.log("\n=== Claim successful! ===");
            console.log("Wrapped tokens minted to your ATA:", recipientAta.toBase58());
            console.log("Wrapped mint:", wrappedMint.toBase58());
        } else {
            console.log("\nTransaction reverted. Check Rome EVM logs for details.");
        }
    } catch (e: any) {
        console.error("Claim failed:", e.message?.slice(0, 500));
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
