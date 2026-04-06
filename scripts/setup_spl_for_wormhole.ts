/**
 * Set up SPL tokens for Wormhole bridging on Rome EVM.
 *
 * For WSOL: sends native SOL to the WSOL ATA via SystemProgram, then syncs native.
 *
 * Usage:
 *   MONTI_SPL_PRIVATE_KEY=0x... npx hardhat run scripts/setup_spl_for_wormhole.ts --network monti_spl
 */
import hardhat from "hardhat";
import { PublicKey } from "@solana/web3.js";
import { encodeFunctionData } from "viem";

const BRIDGE_ADDRESS = "0xbea26188700465d33eb29a0f4ada72de0fb08780" as const;

const SPL_TOKEN_PK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM  = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const CPI_PRECOMPILE         = "0xFF00000000000000000000000000000000000008" as const;
const SYSTEM_PRECOMPILE      = "0xfF00000000000000000000000000000000000007" as const;

function getAta(mint: PublicKey, owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), SPL_TOKEN_PK.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM,
    )[0];
}

function pkHex(pk: PublicKey): `0x${string}` {
    return `0x${Buffer.from(pk.toBytes()).toString("hex")}` as `0x${string}`;
}

const cpiAbi = [{
    name: "account_info",
    type: "function" as const,
    stateMutability: "view" as const,
    inputs: [{ name: "pubkey", type: "bytes32" as const }],
    outputs: [
        { name: "lamports", type: "uint64" as const },
        { name: "owner", type: "bytes32" as const },
        { name: "is_signer", type: "bool" as const },
        { name: "is_writable", type: "bool" as const },
        { name: "executable", type: "bool" as const },
        { name: "data", type: "bytes" as const },
    ],
}] as const;

const systemTransferAbi = [{
    name: "transfer",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
        { name: "to", type: "bytes32" as const },
        { name: "amount", type: "uint64" as const },
        { name: "salt", type: "bytes32" as const },
    ],
    outputs: [],
}] as const;

const splTokenTransferAbi = [{
    name: "transfer",
    type: "function" as const,
    stateMutability: "nonpayable" as const,
    inputs: [
        { name: "to", type: "bytes32" as const },
        { name: "mint", type: "bytes32" as const },
        { name: "amount", type: "uint256" as const },
    ],
    outputs: [],
}] as const;

async function main() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    const bridge = await viem.getContractAt("RomeWormholeBridge", BRIDGE_ADDRESS);

    console.log("=== Setup SPL for Wormhole ===");
    console.log("EVM wallet:", wallet.account.address);
    const balance = await publicClient.getBalance({ address: wallet.account.address });
    console.log("Balance:   ", balance.toString(), `(${Number(balance) / 1e18} SOL)`);

    const pdaHex = await bridge.read.bridgeUserPda() as `0x${string}`;
    const pda = new PublicKey(Buffer.from(pdaHex.slice(2), "hex"));
    console.log("Your PDA:  ", pda.toBase58());

    const MINT = new PublicKey("So11111111111111111111111111111111111111112");
    const ata = getAta(MINT, pda);
    console.log("\nMint:      ", MINT.toBase58(), "(WSOL)");
    console.log("ATA:       ", ata.toBase58());

    // Check ATA state
    console.log("\n--- ATA Status ---");
    let ataExists = false;
    let currentBalance = 0n;
    try {
        const info = await publicClient.readContract({
            address: CPI_PRECOMPILE,
            abi: cpiAbi,
            functionName: "account_info",
            args: [pkHex(ata)],
        });
        const data = info[5] as `0x${string}`;
        if (data !== "0x" && data.length > 130) {
            ataExists = true;
            const rawHex = (data as string).slice(2);
            const amountBuf = Buffer.from(rawHex.slice(128, 144), "hex");
            currentBalance = amountBuf.readBigUInt64LE();
            console.log("ATA exists! Current balance:", currentBalance.toString(), "lamports");
        } else {
            console.log("ATA exists but has no data");
        }
    } catch {
        console.log("ATA does not exist");
    }

    if (!ataExists) {
        console.log("\nATA not found. It should have been created by the previous run.");
        console.log("Run this script again to retry.");
        return;
    }

    // For WSOL, we send native SOL to the ATA account via SystemProgram.transfer
    // The WSOL ATA holds native SOL lamports as its "token balance"
    const FUND_AMOUNT = BigInt(1_000_000); // 0.001 SOL

    console.log(`\n--- Funding ATA with ${FUND_AMOUNT} lamports (${Number(FUND_AMOUNT) / 1e9} SOL) ---`);

    // Use SystemProgram.transfer to send SOL to the ATA
    const salt = "0x0000000000000000000000000000000000000000000000000000000000000001" as `0x${string}`;
    const transferData = encodeFunctionData({
        abi: systemTransferAbi,
        functionName: "transfer",
        args: [pkHex(ata), FUND_AMOUNT, salt],
    });

    try {
        const tx = await wallet.sendTransaction({
            to: SYSTEM_PRECOMPILE,
            data: transferData,
            gas: 5_000_000n,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log("SOL transfer TX:", tx, "Status:", receipt.status);
    } catch (e: any) {
        console.log("SOL transfer failed:", e.message?.slice(0, 300));
        return;
    }

    // Now use SyncNative to update the WSOL balance
    // SyncNative is SPL Token instruction index 17
    // We call it via CPI to the SPL Token program
    console.log("\n--- Syncing native SOL to WSOL balance ---");
    const syncNativeIxData = new Uint8Array([17]); // SyncNative discriminator
    const splTokenProgramHex = pkHex(SPL_TOKEN_PK);

    const invokeAbi = [{
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
        outputs: [],
    }] as const;

    try {
        // Call CPI invoke for SyncNative on the ATA
        const syncData = encodeFunctionData({
            abi: invokeAbi,
            functionName: "invoke",
            args: [
                splTokenProgramHex,
                [{ pubkey: pkHex(ata), is_signer: false, is_writable: true }],
                `0x11` as `0x${string}`, // SyncNative = 17 = 0x11
            ],
        });

        const tx = await wallet.sendTransaction({
            to: CPI_PRECOMPILE,
            data: syncData,
            gas: 5_000_000n,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log("SyncNative TX:", tx, "Status:", receipt.status);
    } catch (e: any) {
        console.log("SyncNative failed:", e.message?.slice(0, 300));
        console.log("(WSOL balance may still be updated from the SOL transfer)");
    }

    // Check final balance
    console.log("\n--- Final ATA balance ---");
    try {
        const info = await publicClient.readContract({
            address: CPI_PRECOMPILE,
            abi: cpiAbi,
            functionName: "account_info",
            args: [pkHex(ata)],
        });
        const data = info[5] as `0x${string}`;
        if (data !== "0x" && data.length > 130) {
            const rawHex = (data as string).slice(2);
            const amountBuf = Buffer.from(rawHex.slice(128, 144), "hex");
            const finalBalance = amountBuf.readBigUInt64LE();
            const lamports = info[0];
            console.log("ATA lamports:", lamports.toString());
            console.log("WSOL balance:", finalBalance.toString(), "lamports");
            if (finalBalance > 0n) {
                console.log("\n✓ Your PDA now has WSOL! Ready for Wormhole transfer.");
            }
        }
    } catch (e: any) {
        console.log("Could not read ATA:", e.message?.slice(0, 120));
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
