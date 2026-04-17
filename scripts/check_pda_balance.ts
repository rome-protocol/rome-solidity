/**
 * Quick check: PDA balance and whether we can create + mint a test SPL token.
 */
import hardhat from "hardhat";
import { PublicKey } from "@solana/web3.js";
import { encodeFunctionData } from "viem";

const BRIDGE_ADDRESS = "0xbea26188700465d33eb29a0f4ada72de0fb08780" as const;
const CPI_PRECOMPILE = "0xFF00000000000000000000000000000000000008" as const;
const SYSTEM_PRECOMPILE = "0xfF00000000000000000000000000000000000007" as const;
const SPL_TOKEN_PRECOMPILE = "0xff00000000000000000000000000000000000005" as const;
const ASSOC_TOKEN_PRECOMPILE = "0xFF00000000000000000000000000000000000006" as const;

const SPL_TOKEN_PK = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function pkHex(pk: PublicKey): `0x${string}` {
    return `0x${Buffer.from(pk.toBytes()).toString("hex")}` as `0x${string}`;
}
function getAta(mint: PublicKey, owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), SPL_TOKEN_PK.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM,
    )[0];
}

const cpiAbi = [{
    name: "account_info", type: "function" as const, stateMutability: "view" as const,
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

async function main() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    const bridge = await viem.getContractAt("RomeWormholeBridge", BRIDGE_ADDRESS);

    const pdaHex = await bridge.read.bridgeUserPda() as `0x${string}`;
    const pda = new PublicKey(Buffer.from(pdaHex.slice(2), "hex"));

    console.log("EVM Wallet:", wallet.account.address);
    console.log("EVM Balance:", (await publicClient.getBalance({ address: wallet.account.address })).toString());
    console.log("Solana PDA:", pda.toBase58());

    // Check PDA SOL balance
    console.log("\n--- PDA Account ---");
    try {
        const info = await publicClient.readContract({
            address: CPI_PRECOMPILE, abi: cpiAbi, functionName: "account_info",
            args: [pdaHex],
        });
        console.log("PDA lamports:", info[0].toString(), `(${Number(info[0]) / 1e9} SOL)`);
    } catch (e: any) {
        console.log("PDA not found or error:", e.message?.slice(0, 100));
    }

    // Step 1: Create a test SPL mint via SystemProgram.create_account + CPI
    console.log("\n--- Creating test SPL mint ---");

    // create_account: owner=SPL_TOKEN_PROGRAM, len=82 (Mint account size), user=wallet, salt
    const splTokenHex = pkHex(SPL_TOKEN_PK);
    // Use a unique salt to derive a fresh account (not the user's PDA)
    const salt = "0x00000000000000000000000000000000000000000000000000000000deadbeef" as `0x${string}`;

    const createAccountAbi = [{
        name: "create_account", type: "function" as const, stateMutability: "nonpayable" as const,
        inputs: [
            { name: "owner", type: "bytes32" as const },
            { name: "len", type: "uint64" as const },
            { name: "user", type: "address" as const },
            { name: "salt", type: "bytes32" as const },
        ],
        outputs: [{ name: "", type: "bytes32" as const }],
    }] as const;

    // First, derive the address via staticcall so we know the pubkey before creating
    let mintPubkeyHex: `0x${string}`;
    try {
        mintPubkeyHex = await publicClient.readContract({
            address: SYSTEM_PRECOMPILE,
            abi: createAccountAbi,
            functionName: "create_account",
            args: [splTokenHex, BigInt(82), wallet.account.address, salt],
        }) as `0x${string}`;
        console.log("Mint will be at:", mintPubkeyHex);
    } catch (e: any) {
        // staticcall might fail if account already exists (from previous run)
        // or if the precompile doesn't support staticcall for this function
        console.log("staticcall for address derivation failed:", e.message?.slice(0, 200));
        console.log("Trying to create directly...");
        mintPubkeyHex = "0x" as `0x${string}`;
    }

    // Now actually create the account
    try {
        const createData = encodeFunctionData({
            abi: createAccountAbi,
            functionName: "create_account",
            args: [splTokenHex, BigInt(82), wallet.account.address, salt],
        });
        const tx = await wallet.sendTransaction({
            to: SYSTEM_PRECOMPILE,
            data: createData,
            gas: 5_000_000n,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log("create_account TX:", tx, "Status:", receipt.status);

        // If staticcall didn't give us the address, parse from logs
        if (mintPubkeyHex === "0x" && receipt.logs.length > 0) {
            console.log("Checking logs for mint address...");
            console.log("Logs:", JSON.stringify(receipt.logs.map(l => l.data).slice(0, 3)));
        }
    } catch (e: any) {
        const msg = e.message || "";
        if (msg.includes("existing account")) {
            console.log("Account already exists (from previous run). Continuing...");
        } else {
            console.log("create_account error:", msg.slice(0, 300));
            return;
        }
    }

    if (mintPubkeyHex === "0x") {
        console.log("Could not determine mint address. Exiting.");
        return;
    }

    const mintPk = new PublicKey(Buffer.from(mintPubkeyHex!.slice(2), "hex"));
    console.log("Mint base58:", mintPk.toBase58());

    // Step 2: Initialize the mint via CPI (InitializeMint2 = instruction 20)
    // Data: [20, decimals(u8), mint_authority(32 bytes), freeze_authority_option(1 + 32 bytes)]
    console.log("\n--- Initializing mint ---");
    const decimals = 9;
    const initMintData = new Uint8Array(67);
    initMintData[0] = 20; // InitializeMint2
    initMintData[1] = decimals;
    // mint_authority = our PDA
    const pdaBytes = Buffer.from(pdaHex.slice(2), "hex");
    initMintData.set(pdaBytes, 2);
    initMintData[34] = 0; // no freeze authority (COption::None)

    const invokeAbi = [{
        name: "invoke", type: "function" as const, stateMutability: "nonpayable" as const,
        inputs: [
            { name: "program_id", type: "bytes32" as const },
            {
                name: "accounts", type: "tuple[]" as const,
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
        const initData = encodeFunctionData({
            abi: invokeAbi,
            functionName: "invoke",
            args: [
                splTokenHex,
                [{ pubkey: mintPubkeyHex!, is_signer: false, is_writable: true }],
                `0x${Buffer.from(initMintData).toString("hex")}` as `0x${string}`,
            ],
        });
        const tx = await wallet.sendTransaction({
            to: CPI_PRECOMPILE, data: initData, gas: 5_000_000n,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log("InitializeMint2 TX:", tx, "Status:", receipt.status);
    } catch (e: any) {
        console.log("InitializeMint2 error:", e.message?.slice(0, 300));
    }

    // Step 3: Create ATA for our PDA for this new mint
    console.log("\n--- Creating ATA for test mint ---");
    const ata = getAta(mintPk, pda);
    console.log("ATA:", ata.toBase58());

    const assocTokenAbi = [{
        name: "create_associated_token_account", type: "function" as const, stateMutability: "nonpayable" as const,
        inputs: [
            { name: "wallet", type: "bytes32" as const },
            { name: "mint", type: "bytes32" as const },
        ],
        outputs: [{ name: "", type: "bytes32" as const }],
    }] as const;

    try {
        const createAtaData = encodeFunctionData({
            abi: assocTokenAbi,
            functionName: "create_associated_token_account",
            args: [pdaHex, mintPubkeyHex!],
        });
        const tx = await wallet.sendTransaction({
            to: ASSOC_TOKEN_PRECOMPILE, data: createAtaData, gas: 5_000_000n,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log("Create ATA TX:", tx, "Status:", receipt.status);
    } catch (e: any) {
        console.log("Create ATA error:", e.message?.slice(0, 200));
    }

    // Step 4: MintTo — mint tokens to our ATA
    // SPL Token MintTo = instruction 7
    // Data: [7, amount(u64 LE)]
    // Accounts: [mint(writable), destination(writable), authority(signer)]
    console.log("\n--- Minting tokens ---");
    const mintAmount = BigInt(1_000_000_000); // 1 token (9 decimals)
    const mintToData = new Uint8Array(9);
    mintToData[0] = 7; // MintTo
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(mintAmount);
    mintToData.set(amountBuf, 1);

    try {
        const mintToCalldata = encodeFunctionData({
            abi: invokeAbi,
            functionName: "invoke",
            args: [
                splTokenHex,
                [
                    { pubkey: mintPubkeyHex!, is_signer: false, is_writable: true },  // mint
                    { pubkey: pkHex(ata), is_signer: false, is_writable: true },       // destination ATA
                    { pubkey: pdaHex, is_signer: true, is_writable: false },           // authority (our PDA)
                ],
                `0x${Buffer.from(mintToData).toString("hex")}` as `0x${string}`,
            ],
        });
        const tx = await wallet.sendTransaction({
            to: CPI_PRECOMPILE, data: mintToCalldata, gas: 5_000_000n,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log("MintTo TX:", tx, "Status:", receipt.status);
    } catch (e: any) {
        console.log("MintTo error:", e.message?.slice(0, 300));
    }

    // Step 5: Check final balance
    console.log("\n--- Final ATA balance ---");
    try {
        const info = await publicClient.readContract({
            address: CPI_PRECOMPILE, abi: cpiAbi, functionName: "account_info",
            args: [pkHex(ata)],
        });
        const data = info[5] as `0x${string}`;
        if (data !== "0x" && data.length > 130) {
            const rawHex = (data as string).slice(2);
            const amountBytes = Buffer.from(rawHex.slice(128, 144), "hex");
            const balance = amountBytes.readBigUInt64LE();
            console.log("Token balance:", balance.toString());
            console.log("Mint:", mintPk.toBase58());
            if (balance > 0n) {
                console.log("\nReady for Wormhole transfer!");
                console.log("Update MINT in wormhole_transfer.ts to:", mintPk.toBase58());
                console.log("Mint hex:", mintPubkeyHex);
            }
        }
    } catch (e: any) {
        console.log("Error:", e.message?.slice(0, 120));
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
