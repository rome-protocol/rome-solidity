/**
 * Post VAA + simulate completeTransferWrapped via NATIVE Solana transaction.
 * Tests the corrected VAA (recipient = ATA, not PDA).
 *
 * Usage: npx hardhat run scripts/native_solana_claim.ts --network hardhatMainnet
 */
import {
    Connection, Keypair, PublicKey, Transaction,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import { deserialize } from "@wormhole-foundation/sdk-connect";
import { utils as coreUtils } from "@wormhole-foundation/sdk-solana-core";
import {
    deriveWrappedMintKey,
    createCompleteTransferWrappedInstruction,
} from "@wormhole-foundation/sdk-solana-tokenbridge";

const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
const WORMHOLE_CORE = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
const TOKEN_BRIDGE = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const SPL_TOKEN_PK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY environment variable is required. Usage: EVM_PRIVATE_KEY=<hex> npx hardhat run scripts/native_solana_claim.ts --network hardhatMainnet");
}

// Corrected VAA: sequence 343845, recipient = ATA (not PDA)
const DEFAULT_VAA_B64 =
    "AQAAAAABAHO2tguVURf8Pl70z/kBSE2sM544ET7xfBxgYqz/E99MGplUCuhUAijZvdBy8Oi9iLm9vUstensQ3UolN2KJkfIBadP+nAAAAAAnEgAAAAAAAAAAAAAAANtUkiZfYDiDHon0lWcP+Qmt6UvZAAAAAAAFPyUBAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYagAAAAAAAAAAAAAAAA7vEqg+5bcWHThzMXyODnt24LXZwnEiw4QaLvURhcFpb3j+Feg6pV/mvLuEMjniy+b/GfWc68AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

function getAta(mint: PublicKey, owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), SPL_TOKEN_PK.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM,
    )[0];
}

async function main() {
    const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");
    const payer = Keypair.fromSeed(Buffer.from(EVM_PRIVATE_KEY, "hex"));
    const pda = new PublicKey(Buffer.from("1f8d99b0be76e3e279322fb00689009cf921507c8210041ed6f6d2732b2d5ce0", "hex"));

    console.log("Payer:", payer.publicKey.toBase58());
    console.log("PDA:", pda.toBase58());
    console.log("Payer balance:", (await connection.getBalance(payer.publicKey)) / 1e9, "SOL");

    const vaaBytes = Buffer.from(DEFAULT_VAA_B64, "base64");
    const vaa = deserialize("TokenBridge:Transfer", vaaBytes) as any;
    console.log("\nVAA: sequence", vaa.sequence?.toString(), "emitter:", vaa.emitterChain);

    // Extract token info
    const sigCount = vaaBytes[5];
    const bodyOff = 6 + sigCount * 66;
    const payload = vaaBytes.subarray(bodyOff + 51);
    const tokenAddress = payload.subarray(33, 65);
    const tokenChain = payload.readUInt16BE(65);
    const toAddr = payload.subarray(67, 99);

    const wrappedMint = deriveWrappedMintKey(TOKEN_BRIDGE, tokenChain, tokenAddress);
    const recipientAta = getAta(wrappedMint, pda);
    const vaaToKey = new PublicKey(toAddr);

    console.log("Wrapped mint:", wrappedMint.toBase58());
    console.log("Recipient ATA:", recipientAta.toBase58());
    console.log("VAA to:", vaaToKey.toBase58());
    console.log("ATA == VAA to:", recipientAta.equals(vaaToKey));

    // --- Post VAA if needed ---
    const vaaHash = Buffer.from(vaa.hash);
    const postedVaaKey = coreUtils.derivePostedVaaKey(WORMHOLE_CORE, vaaHash);
    const postedVaaInfo = await connection.getAccountInfo(postedVaaKey);

    if (postedVaaInfo) {
        console.log("\nPostedVAA already exists:", postedVaaKey.toBase58());
    } else {
        console.log("\nPosting VAA to Solana devnet...");
        const signatureSet = Keypair.generate();

        const verifyIxs = await coreUtils.createVerifySignaturesInstructions(
            connection,
            WORMHOLE_CORE,
            payer.publicKey,
            vaa,
            signatureSet.publicKey,
        );

        console.log(`  ${verifyIxs.length} verify instructions`);
        for (let i = 0; i < verifyIxs.length; i += 2) {
            const batch = verifyIxs.slice(i, i + 2);
            const tx = new Transaction().add(...batch);
            tx.feePayer = payer.publicKey;
            const sig = await sendAndConfirmTransaction(connection, tx, [payer, signatureSet]);
            console.log(`  verify tx ${i / 2 + 1}:`, sig);
        }

        const postIx = coreUtils.createPostVaaInstruction(
            connection,
            WORMHOLE_CORE,
            payer.publicKey,
            vaa,
            signatureSet.publicKey,
        );
        const postTx = new Transaction().add(postIx);
        postTx.feePayer = payer.publicKey;
        const postSig = await sendAndConfirmTransaction(connection, postTx, [payer]);
        console.log("  post_vaa tx:", postSig);
    }

    // --- Build completeTransferWrapped ---
    // With corrected VAA, the SDK will set to = ATA (from VAA payload), which is correct
    const ix = createCompleteTransferWrappedInstruction(
        connection,
        TOKEN_BRIDGE,
        WORMHOLE_CORE,
        payer.publicKey,
        vaa,
        recipientAta, // feeRecipient = ATA
    );

    console.log("\n=== INSTRUCTION ===");
    console.log("Accounts:", ix.keys.length);
    for (let i = 0; i < ix.keys.length; i++) {
        const k = ix.keys[i];
        console.log(`  [${i}] ${k.pubkey.toBase58()} signer=${k.isSigner} writable=${k.isWritable}`);
    }

    // --- Simulate ---
    const tx = new Transaction().add(ix);
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    console.log("\n=== SIMULATION ===");
    const sim = await connection.simulateTransaction(tx, [payer]);
    console.log("Error:", JSON.stringify(sim.value.err));
    sim.value.logs?.forEach(l => console.log("  ", l));

    if (!sim.value.err) {
        console.log("\nSimulation PASSED! Sending real transaction...");
        const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
        console.log("TX:", sig);
        console.log("SUCCESS — tokens claimed via native Solana tx!");
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
