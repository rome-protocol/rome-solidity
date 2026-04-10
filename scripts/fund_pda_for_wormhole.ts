/**
 * Fund your Rome PDA with SPL tokens for Wormhole bridging.
 *
 * This script:
 *   1. Shows your PDA and its ATA for a given mint
 *   2. Creates the ATA if it doesn't exist (via Rome's AssociatedSplToken precompile)
 *   3. Checks your SPL token balance
 *
 * To actually fund the ATA, you have two options:
 *   A) From Solana CLI: `spl-token transfer <MINT> <AMOUNT> <YOUR_PDA> --url <SOLANA_RPC>`
 *   B) From Rome EVM:   Use the ISplToken precompile `transfer(to, mint, amount)` if you
 *      already have tokens in another Rome EVM account.
 *
 * Usage:
 *   MONTI_SPL_PRIVATE_KEY=0x... npx hardhat run scripts/fund_pda_for_wormhole.ts --network monti_spl
 */
import hardhat from "hardhat";
import { PublicKey } from "@solana/web3.js";

const BRIDGE_ADDRESS = "0xbea26188700465d33eb29a0f4ada72de0fb08780";
const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Precompile addresses
const SPL_TOKEN_PRECOMPILE    = "0xff00000000000000000000000000000000000005" as const;
const ASSOC_TOKEN_PRECOMPILE  = "0xFF00000000000000000000000000000000000006" as const;
const SYSTEM_PRECOMPILE       = "0xfF00000000000000000000000000000000000007" as const;
const CPI_PRECOMPILE          = "0xFF00000000000000000000000000000000000008" as const;

function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), SPL_TOKEN.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM,
    )[0];
}

function pkToHex(pk: PublicKey): `0x${string}` {
    return `0x${Buffer.from(pk.toBytes()).toString("hex")}` as `0x${string}`;
}

async function main() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    const bridge = await viem.getContractAt("RomeWormholeBridge", BRIDGE_ADDRESS);

    console.log("=== Fund PDA for Wormhole ===");
    console.log("EVM Wallet:", wallet.account.address);
    console.log("ETH Balance:", (await publicClient.getBalance({ address: wallet.account.address })).toString());

    // 1. Get your PDA
    const pdaHex = await bridge.read.bridgeUserPda() as string;
    const pda = new PublicKey(Buffer.from(pdaHex.slice(2), "hex"));
    console.log("\nYour Solana PDA:", pda.toBase58());
    console.log("PDA (hex):      ", pdaHex);

    // 2. Check native SOL balance of PDA via CPI precompile
    console.log("\n--- PDA Solana Account Info ---");
    try {
        const cpiAbi = [
            "function account_info(bytes32 pubkey) external view returns(uint64 lamports, bytes32 owner, bool is_signer, bool is_writable, bool executable, bytes data)"
        ];
        const result = await publicClient.readContract({
            address: CPI_PRECOMPILE,
            abi: [{
                name: "account_info",
                type: "function",
                stateMutability: "view",
                inputs: [{ name: "pubkey", type: "bytes32" }],
                outputs: [
                    { name: "lamports", type: "uint64" },
                    { name: "owner", type: "bytes32" },
                    { name: "is_signer", type: "bool" },
                    { name: "is_writable", type: "bool" },
                    { name: "executable", type: "bool" },
                    { name: "data", type: "bytes" },
                ],
            }],
            functionName: "account_info",
            args: [pdaHex as `0x${string}`],
        });
        const lamports = result[0];
        console.log("PDA lamports:", lamports.toString(), `(${Number(lamports) / 1e9} SOL)`);
    } catch (e: any) {
        console.log("Could not read PDA account info:", e.message?.slice(0, 120));
    }

    // 3. Check a specific mint's ATA
    // Change this to whichever mint you want to bridge
    const MINT = new PublicKey("So11111111111111111111111111111111111111112"); // WSOL

    const ata = getAssociatedTokenAddress(MINT, pda);
    console.log("\n--- Token Account ---");
    console.log("Mint:   ", MINT.toBase58());
    console.log("ATA:    ", ata.toBase58());
    console.log("ATA hex:", pkToHex(ata));

    // 4. Check if ATA exists and has balance
    try {
        const ataInfo = await publicClient.readContract({
            address: CPI_PRECOMPILE,
            abi: [{
                name: "account_info",
                type: "function",
                stateMutability: "view",
                inputs: [{ name: "pubkey", type: "bytes32" }],
                outputs: [
                    { name: "lamports", type: "uint64" },
                    { name: "owner", type: "bytes32" },
                    { name: "is_signer", type: "bool" },
                    { name: "is_writable", type: "bool" },
                    { name: "executable", type: "bool" },
                    { name: "data", type: "bytes" },
                ],
            }],
            functionName: "account_info",
            args: [pkToHex(ata)],
        });

        const ataLamports = ataInfo[0];
        const ataData = ataInfo[5] as `0x${string}`;

        if (ataData === "0x" || ataData.length <= 2) {
            console.log("ATA does NOT exist yet.");
            console.log("\nCreating ATA via AssociatedSplToken precompile...");

            const createAtaTx = await wallet.sendTransaction({
                to: ASSOC_TOKEN_PRECOMPILE,
                data: encodeFunctionData(
                    "create_associated_token_account(bytes32,bytes32)",
                    [pdaHex as `0x${string}`, pkToHex(MINT)],
                ),
                gas: 500_000n,
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: createAtaTx });
            console.log("ATA created! TX:", createAtaTx, "Status:", receipt.status);
        } else {
            // Parse token account data: mint(32) + owner(32) + amount(u64 LE at offset 64)
            const rawHex = ataData.slice(2); // remove 0x
            const amountHex = rawHex.slice(128, 144); // bytes 64-72 = amount (u64 LE)
            const amountBytes = Buffer.from(amountHex, "hex");
            const amount = amountBytes.readBigUInt64LE();
            console.log("ATA exists!");
            console.log("Token balance:", amount.toString());
        }
    } catch (e: any) {
        console.log("ATA does not exist (account_info failed):", e.message?.slice(0, 120));
    }

    // 5. Show funding options
    console.log("\n=== How to fund your PDA ===");
    console.log("");
    console.log("Option A — From Solana CLI (if Rome shares Solana state):");
    console.log(`  solana config set --url <ROME_SOLANA_RPC>`);
    console.log(`  spl-token transfer ${MINT.toBase58()} <AMOUNT> ${pda.toBase58()}`);
    console.log("");
    console.log("Option B — Transfer native SOL via Rome EVM precompile:");
    console.log(`  Call SystemProgram.transfer(to, amount, salt) to send SOL to your PDA`);
    console.log(`  Then use ISplToken.transfer(to, mint, amount) if you already have SPL tokens`);
    console.log("");
    console.log("Option C — Use the ISplToken precompile transfer:");
    console.log(`  SplToken.transfer(<recipientATA>, <mint>, <amount>)`);
    console.log(`  Precompile address: ${SPL_TOKEN_PRECOMPILE}`);
}

function encodeFunctionData(sig: string, args: `0x${string}`[]): `0x${string}` {
    const { Interface } = require("ethers");
    const iface = new Interface([`function ${sig}`]);
    const name = sig.split("(")[0];
    return iface.encodeFunctionData(name, args) as `0x${string}`;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
