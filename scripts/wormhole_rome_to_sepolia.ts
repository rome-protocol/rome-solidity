/**
 * Outbound Wormhole transfer: Rome EVM (wrapped WETH) → Sepolia ETH.
 *
 * This script uses the RomeWormholeBridge contract's `sendTransferWrapped` function
 * with `invoke_signed` to sign for a PDA-derived message account, solving the
 * fresh-keypair signer limitation of the CPI precompile.
 *
 * Prerequisites:
 *   1. RomeWormholeBridge deployed (scripts/deploy_wormhole_bridge.ts)
 *   2. Wrapped WETH balance in your PDA's ATA on Rome (from a prior inbound transfer)
 *   3. SOL in your Rome PDA on Solana devnet (for CPI gas)
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
 */
import hardhat from "hardhat";
import { randomBytes } from "crypto";
import {
    Connection, PublicKey,
    SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { encodeFunctionData } from "viem";
import {
    publicKeyToBytes32Hex,
    solanaAccountMetasToRome,
    deriveMessagePda,
    encodeRomeWormholeSendTransferWrapped,
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

// WETH on Sepolia (the token we're unwrapping back to)
const SEPOLIA_WETH_PADDED = Buffer.from(
    "000000000000000000000000eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c", "hex",
);

// Solana Devnet
const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";
const WORMHOLE_CORE = new PublicKey("3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5");
const TOKEN_BRIDGE = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const SPL_TOKEN_PK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

// Rome EVM
const DEFAULT_BRIDGE = "0x79f34fa78651efa9d24ff8ac526cbd9753e8fc1f";
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

/** Derive the user's PDA off-chain (same as RomeEVMAccount.pda() on-chain). */
function deriveUserPda(evmAddress: string): PublicKey {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("EXTERNAL_AUTHORITY"), Buffer.from(evmAddress.slice(2), "hex")],
        ROME_EVM_PROGRAM,
    )[0];
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
// Build transferWrapped account list (Anchor IDL order)
// ---------------------------------------------------------------------------

function getTransferWrappedMetas(params: {
    payer: PublicKey;
    messagePda: PublicKey;
    senderAta: PublicKey;
    wrappedMint: PublicKey;
    wrappedMeta: PublicKey;
    tokenBridgeConfig: PublicKey;
    authoritySigner: PublicKey;
    wormholeBridge: PublicKey;
    wormholeEmitter: PublicKey;
    wormholeSequence: PublicKey;
    wormholeFeeCollector: PublicKey;
    senderAccount: PublicKey;
}) {
    return [
        { pubkey: params.payer,                isSigner: true,  isWritable: true  },
        { pubkey: params.tokenBridgeConfig,    isSigner: false, isWritable: false },
        { pubkey: params.senderAta,            isSigner: false, isWritable: true  },
        { pubkey: params.payer,                isSigner: true,  isWritable: false }, // fromOwner = payer (user PDA)
        { pubkey: params.wrappedMint,          isSigner: false, isWritable: true  },
        { pubkey: params.wrappedMeta,          isSigner: false, isWritable: false },
        { pubkey: params.authoritySigner,      isSigner: false, isWritable: false },
        { pubkey: params.wormholeBridge,       isSigner: false, isWritable: true  },
        { pubkey: params.messagePda,           isSigner: true,  isWritable: true  },
        { pubkey: params.wormholeEmitter,      isSigner: false, isWritable: false },
        { pubkey: params.wormholeSequence,     isSigner: false, isWritable: true  },
        { pubkey: params.wormholeFeeCollector, isSigner: false, isWritable: true  },
        { pubkey: SYSVAR_CLOCK_PUBKEY,         isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY,          isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM,              isSigner: false, isWritable: false },
        { pubkey: SPL_TOKEN_PK,                isSigner: false, isWritable: false },
        { pubkey: WORMHOLE_CORE,               isSigner: false, isWritable: false },
        { pubkey: params.senderAccount,        isSigner: false, isWritable: false },
    ];
}

// ---------------------------------------------------------------------------
// Phase 1: Send from Rome (outbound via bridge contract)
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
        console.log("(bridgeUserPda not available — deriving off-chain)");
        userPda = deriveUserPda(wallet.account.address);
    }
    console.log("User PDA:", userPda.toBase58());

    // 2. Derive wrapped mint + check ATA balance
    const wrappedMint = deriveWrappedMintKey(TOKEN_BRIDGE, SEPOLIA_WORMHOLE_CHAIN_ID, SEPOLIA_WETH_PADDED);
    const senderAta = getAta(wrappedMint, userPda);
    console.log("Wrapped mint:", wrappedMint.toBase58());
    console.log("Sender ATA:", senderAta.toBase58());

    const connection = new Connection(SOLANA_DEVNET_RPC, "confirmed");
    const ataInfo = await connection.getAccountInfo(senderAta);
    if (!ataInfo || ataInfo.data.length < 72) {
        console.log("\nERROR: Sender ATA does not exist. Run an inbound transfer first.");
        return;
    }
    const balance = ataInfo.data.readBigUInt64LE(64);
    console.log("ATA balance:", balance.toString(), `(${Number(balance) / 1e8} WETH)`);

    const amount = BigInt(process.env.AMOUNT || "10000"); // 0.0001 WETH default
    if (balance < amount) {
        console.log(`\nERROR: Insufficient balance. Have ${balance}, need ${amount}.`);
        return;
    }

    // 3. Generate message salt and derive message PDA
    const messageSalt = randomBytes(32);
    const messageSaltHex = `0x${messageSalt.toString("hex")}` as `0x${string}`;
    const messagePda = deriveMessagePda(wallet.account.address, messageSalt, ROME_EVM_PROGRAM);
    console.log("\nMessage salt:", messageSaltHex);
    console.log("Message PDA:", messagePda.toBase58());

    // 4. Derive all accounts for transferWrapped
    const authoritySigner = deriveAuthoritySignerKey(TOKEN_BRIDGE);
    const tokenBridgeConfig = deriveTokenBridgeConfigKey(TOKEN_BRIDGE);
    const wrappedMeta = deriveWrappedMetaKey(TOKEN_BRIDGE, wrappedMint);
    const senderAccount = deriveSenderAccountKey(TOKEN_BRIDGE);

    // Wormhole Core accounts (derived from the Token Bridge's post_message CPI)
    const wormholeBridge = coreUtils.deriveWormholeBridgeDataKey(WORMHOLE_CORE);
    const wormholeEmitter = coreUtils.deriveWormholeEmitterKey(TOKEN_BRIDGE);
    const wormholeSequence = coreUtils.deriveEmitterSequenceKey(wormholeEmitter, WORMHOLE_CORE);
    const wormholeFeeCollector = coreUtils.deriveFeeCollectorKey(WORMHOLE_CORE);

    // SPL approve accounts: [source ATA, delegate (authority signer), owner (user PDA)]
    const approveMetas = [
        { pubkey: senderAta,       isSigner: false, isWritable: true  },
        { pubkey: authoritySigner,  isSigner: false, isWritable: false },
        { pubkey: userPda,          isSigner: true,  isWritable: false },
    ];

    // Transfer accounts (Anchor IDL order for transfer_wrapped)
    const transferMetas = getTransferWrappedMetas({
        payer: userPda,
        messagePda,
        senderAta,
        wrappedMint,
        wrappedMeta,
        tokenBridgeConfig,
        authoritySigner,
        wormholeBridge,
        wormholeEmitter,
        wormholeSequence,
        wormholeFeeCollector,
        senderAccount,
    });

    // Target: the user's own address on Ethereum, padded to bytes32
    const targetAddressHex =
        `0x000000000000000000000000${wallet.account.address.slice(2)}` as `0x${string}`;

    // 5. Encode calldata
    const sendCalldata = encodeRomeWormholeSendTransferWrapped({
        splTokenProgramId: publicKeyToBytes32Hex(SPL_TOKEN_PK),
        approveAccounts: solanaAccountMetasToRome(approveMetas),
        approveAmount: amount,
        tokenBridgeProgramId: publicKeyToBytes32Hex(TOKEN_BRIDGE),
        transferAccounts: solanaAccountMetasToRome(transferMetas),
        nonce: 0,
        amount,
        fee: 0n,
        targetAddress: targetAddressHex,
        targetChain: ETHEREUM_CHAIN_ID,
        messageSalt: messageSaltHex,
    });

    console.log(`\nApprove accounts:  ${approveMetas.length}`);
    console.log(`Transfer accounts: ${transferMetas.length}`);
    console.log(`Amount:            ${amount} (${Number(amount) / 1e8} WETH)`);
    console.log(`Target:            ${wallet.account.address} on Ethereum`);
    console.log(`Calldata length:   ${(sendCalldata.length - 2) / 2} bytes`);

    // 6. Send the transaction
    console.log("\nSending transaction...");
    const txHash = await wallet.sendTransaction({
        to: bridgeAddr,
        data: sendCalldata,
        gas: 2_000_000n,
    });
    console.log("TX:", txHash);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("Status:", receipt.status);

    if (receipt.status !== "success") {
        console.log("\nTransaction reverted. Check the error above.");
        return;
    }

    console.log("\n=== Step 1 complete ===");
    console.log("Block:", receipt.blockNumber.toString());

    // The Wormhole sequence number is emitted by the Token Bridge's post_message CPI.
    // On Rome, you may need to check the Solana transaction logs or Wormholescan
    // to find the exact sequence number.
    console.log("\nNext steps:");
    console.log("1. Find the Wormhole sequence number on Wormholescan:");
    console.log(`   https://wormholescan.io/#/txs?address=${wormholeEmitter.toBase58()}`);
    console.log("2. Run Step 2 to claim on Sepolia:");
    console.log(`   PHASE=claim SEQ=<sequence> npx hardhat run scripts/wormhole_rome_to_sepolia.ts --network sepolia`);
}

// ---------------------------------------------------------------------------
// Phase 2: Claim on Sepolia
// ---------------------------------------------------------------------------

async function claimOnSepolia() {
    // 1. Get the signed VAA
    let vaaB64: string;

    // For outbound from Solana, the emitter is the Token Bridge on Solana
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

    // 2. Call completeTransferAndUnwrapETH on Sepolia Token Bridge
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    console.log("Wallet:", wallet.account.address);

    const beforeBalance = await publicClient.getBalance({ address: wallet.account.address });
    console.log("ETH balance before:", (Number(beforeBalance) / 1e18).toFixed(6), "ETH");

    // Encode the completeTransferAndUnwrapETH call
    const claimCalldata = encodeFunctionData({
        abi: [{
            name: "completeTransferAndUnwrapETH",
            type: "function" as const,
            stateMutability: "nonpayable" as const,
            inputs: [{ name: "encodedVm", type: "bytes" as const }],
            outputs: [] as const,
        }],
        functionName: "completeTransferAndUnwrapETH",
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
        const gained = Number(afterBalance - beforeBalance) / 1e18;
        console.log("\n=== SUCCESS ===");
        console.log("ETH balance after:", (Number(afterBalance) / 1e18).toFixed(6), "ETH");
        console.log("ETH gained (approx):", gained.toFixed(6), "ETH (minus gas)");
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
