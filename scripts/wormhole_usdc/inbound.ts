/**
 * Wormhole USDC (Sepolia → Rome) — single entrypoint.
 *
 * PHASE=full   — Sepolia lock → VAA poll → Rome claim → PDA ATA + balance (requires USDC_ADDRESS, keys)
 * PHASE=setup  — create PDA ATA for wrapped USDC if missing
 * PHASE=balance — wrapped USDC on PDA ATA (Solana devnet getAccountInfo; avoids Rome CPI 403/502)
 * PHASE=all    — setup then balance (default)
 *
 * SKIP_SEND=1 with PHASE=full — skip Sepolia send; set SEQ or VAA_B64 for claim only.
 *
 * Usage:
 *   PHASE=full … npx hardhat run scripts/wormhole_usdc/inbound.ts --network monti_spl_env
 *   npx hardhat run scripts/wormhole_usdc/inbound.ts --network monti_spl_env
 */
import hardhat from "hardhat";
import { claimOnRome, sendFromSepolia } from "../wormhole_sepolia_to_rome.js";
import { isHardhatOrNodeEntry } from "../lib/helpers.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { encodeFunctionData } from "viem";
import { publicKeyToBytes32Hex } from "@wormhole-foundation/sdk-solana";
import { deriveWrappedMintKey } from "@wormhole-foundation/sdk-solana-tokenbridge";

const SEPOLIA_WH = 10002;
const TOKEN_BRIDGE = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ASSOC_TOKEN_PRECOMPILE = "0xFF00000000000000000000000000000000000006" as const;
const DEFAULT_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

/** Same default as wormhole_sepolia_to_rome.ts — public devnet for SPL reads. */
const SOLANA_RPC = process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";

const ROME_EVM_PROGRAM = new PublicKey(
    process.env.ROME_EVM_PROGRAM || "DP1dshBzmXXVsRxH5kCKMemrDuptg1JvJ1j5AsFV4Hm3",
);

function padEvmTokenAddress(token: string): Buffer {
    return Buffer.from(token.replace(/^0x/i, "").padStart(64, "0"), "hex");
}

function getAta(mint: PublicKey, owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), SPL_TOKEN.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM,
    )[0];
}

function derivePda(evmAddr: string): PublicKey {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("EXTERNAL_AUTHORITY"), Buffer.from(evmAddr.slice(2), "hex")],
        ROME_EVM_PROGRAM,
    )[0];
}

async function ensureAta(): Promise<void> {
    const usdc = (process.env.USDC_ADDRESS || DEFAULT_USDC).trim() as `0x${string}`;
    const ownerMode = (process.env.OWNER || "pda").toLowerCase();

    const evmKey = (process.env.MONTI_SPL_PRIVATE_KEY || "").replace(/^0x/, "");
    if (evmKey.length !== 64) throw new Error("Set MONTI_SPL_PRIVATE_KEY");

    const { viem, networkName } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet");

    const foreign = padEvmTokenAddress(usdc);
    const wrappedMint = deriveWrappedMintKey(TOKEN_BRIDGE, SEPOLIA_WH, foreign);
    const pda = derivePda(wallet.account.address);
    const payer = Keypair.fromSeed(Buffer.from(evmKey, "hex"));
    const walletOwner = ownerMode === "payer" ? payer.publicKey : pda;
    const ata = getAta(wrappedMint, walletOwner);
    const walletBytes32 = publicKeyToBytes32Hex(walletOwner) as `0x${string}`;
    const mintHex = publicKeyToBytes32Hex(wrappedMint) as `0x${string}`;

    console.log("=== PHASE: setup (create ATA if needed) ===");
    console.log("Network:", networkName);
    console.log("Solana RPC (ATA check):", SOLANA_RPC);
    console.log("EVM wallet:", wallet.account.address);
    console.log("OWNER:", ownerMode, "→", walletOwner.toBase58());
    console.log("Wrapped mint:", wrappedMint.toBase58());
    console.log("ATA:", ata.toBase58());

    const sol = new Connection(SOLANA_RPC, "confirmed");
    const acc = await sol.getAccountInfo(ata, "confirmed");
    if (acc && acc.data.length >= 72) {
        console.log("ATA already exists — skip create.\n");
        return;
    }

    const nativeBal = await publicClient.getBalance({ address: wallet.account.address });
    if (nativeBal === 0n) throw new Error("Fund Rome EVM wallet for gas before creating ATA.");

    const txHash = await wallet.sendTransaction({
        to: ASSOC_TOKEN_PRECOMPILE,
        data: encodeFunctionData({
            abi: [{
                name: "create_associated_token_account",
                type: "function",
                stateMutability: "nonpayable",
                inputs: [
                    { name: "wallet", type: "bytes32" },
                    { name: "mint", type: "bytes32" },
                ],
                outputs: [{ name: "", type: "bytes32" }],
            }],
            functionName: "create_associated_token_account",
            args: [walletBytes32, mintHex],
        }),
        gas: 5_000_000n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("create_associated_token_account TX:", txHash, "status:", receipt.status, "\n");
}

async function printBalance(): Promise<void> {
    const usdc = (process.env.USDC_ADDRESS || DEFAULT_USDC).trim();

    const { viem, networkName } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet");

    const pda = derivePda(wallet.account.address);
    const foreign = padEvmTokenAddress(usdc);
    const mint = deriveWrappedMintKey(TOKEN_BRIDGE, SEPOLIA_WH, foreign);
    const ata = getAta(mint, pda);
    const ataHex = publicKeyToBytes32Hex(ata) as `0x${string}`;

    console.log("=== PHASE: balance (Solana devnet — PDA ATA) ===");
    console.log("Network:", networkName);
    console.log("Solana RPC:", SOLANA_RPC);
    console.log("EVM wallet:", wallet.account.address);
    console.log("User PDA:", pda.toBase58());
    console.log("Wrapped USDC mint:", mint.toBase58());
    console.log("PDA ATA (base58):", ata.toBase58());
    console.log("PDA ATA bytes32:", ataHex);

    try {
        const ethBal = await publicClient.getBalance({ address: wallet.account.address });
        console.log("Native (gas) wei:", ethBal.toString());
    } catch {
        console.log("Native (gas) wei: (unavailable)");
    }

    const sol = new Connection(SOLANA_RPC, "confirmed");
    const acc = await sol.getAccountInfo(ata, "confirmed");
    if (!acc || acc.data.length < 72) {
        console.log("\nNo SPL token account on devnet (empty ATA). Run PHASE=setup.\n");
        return;
    }

    const amount = acc.data.readBigUInt64LE(64);
    console.log("\nWrapped USDC — raw:", amount.toString());
    console.log("Wrapped USDC — UI (6 dp):", Number(amount) / 1e6, "\n");
}

async function runFullPipeline(): Promise<void> {
    const skipSend = process.env.SKIP_SEND === "1" || process.env.SKIP_SEND === "true";

    if (!skipSend) {
        const usdc = process.env.USDC_ADDRESS?.trim();
        if (!usdc || !usdc.startsWith("0x") || usdc.length !== 42) {
            throw new Error("PHASE=full requires USDC_ADDRESS (Sepolia Circle USDC 0x + 40 hex).");
        }

        console.log("\n========== 1/3 Lock USDC on Sepolia ==========\n");
        const seq = await sendFromSepolia();
        if (!seq || seq === "unknown") {
            throw new Error("Send did not produce a sequence (check Sepolia balances and logs).");
        }
        process.env.SEQ = seq;
    } else {
        if (!process.env.VAA_B64?.trim() && !process.env.SEQ?.trim()) {
            throw new Error("SKIP_SEND=1 requires SEQ=<n> or VAA_B64=<base64>.");
        }
    }

    console.log("\n========== 2/3 Claim on Rome (poll VAA if needed) ==========\n");
    await claimOnRome();

    console.log("\n========== 3/3 PDA ATA + balance (Solana read) ==========\n");
    await ensureAta();
    await printBalance();

    console.log("Done.\n");
}

async function main() {
    const phase = (process.env.PHASE || "all").toLowerCase();
    if (phase === "full") {
        await runFullPipeline();
    } else if (phase === "setup") {
        await ensureAta();
    } else if (phase === "balance") {
        await printBalance();
    } else if (phase === "all") {
        await ensureAta();
        await printBalance();
    } else {
        throw new Error("PHASE must be full | setup | balance | all");
    }
}

if (isHardhatOrNodeEntry(import.meta.url)) {
    main().catch((e) => {
        console.error(e);
        process.exitCode = 1;
    });
}
