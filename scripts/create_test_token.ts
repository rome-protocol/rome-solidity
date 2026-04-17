/**
 * Create a test SPL token on Rome EVM, mint tokens to the user's PDA ATA,
 * and prepare for Wormhole bridging.
 *
 * Uses Rome precompiles:
 *   - ISystemProgram (0xff...07) — create_account, find_program_address, rome_evm_program_id
 *   - IAssociatedSplToken (0xFF...06) — create ATA
 *   - ICrossProgramInvocation (0xFF...08) — invoke SPL Token InitializeMint2 / MintTo
 *
 * Usage:
 *   MONTI_SPL_PRIVATE_KEY=0x... npx hardhat run scripts/create_test_token.ts --network monti_spl
 */
import hardhat from "hardhat";
import { PublicKey } from "@solana/web3.js";
import { encodeFunctionData } from "viem";

const BRIDGE_ADDRESS = "0xbea26188700465d33eb29a0f4ada72de0fb08780" as const;

const SYSTEM_PRECOMPILE       = "0xfF00000000000000000000000000000000000007" as const;
const ASSOC_TOKEN_PRECOMPILE  = "0xFF00000000000000000000000000000000000006" as const;
const CPI_PRECOMPILE          = "0xFF00000000000000000000000000000000000008" as const;

const SPL_TOKEN_PK  = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM   = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function pkHex(pk: PublicKey): `0x${string}` {
    return `0x${Buffer.from(pk.toBytes()).toString("hex")}` as `0x${string}`;
}
function getAta(mint: PublicKey, owner: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [owner.toBuffer(), SPL_TOKEN_PK.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM,
    )[0];
}

// ABIs for Rome precompiles
const systemAbi = {
    create_account: {
        name: "create_account", type: "function" as const, stateMutability: "nonpayable" as const,
        inputs: [
            { name: "owner", type: "bytes32" as const },
            { name: "len", type: "uint64" as const },
            { name: "user", type: "address" as const },
            { name: "salt", type: "bytes32" as const },
        ],
        outputs: [{ name: "", type: "bytes32" as const }],
    },
    rome_evm_program_id: {
        name: "rome_evm_program_id", type: "function" as const, stateMutability: "view" as const,
        inputs: [],
        outputs: [{ name: "", type: "bytes32" as const }],
    },
    find_program_address: {
        name: "find_program_address", type: "function" as const, stateMutability: "view" as const,
        inputs: [
            { name: "program", type: "bytes32" as const },
            { name: "seeds", type: "tuple[]" as const, components: [{ name: "item", type: "bytes" as const }] },
        ],
        outputs: [
            { name: "", type: "bytes32" as const },
            { name: "", type: "uint8" as const },
        ],
    },
} as const;

const assocTokenAbi = [{
    name: "create_associated_token_account", type: "function" as const, stateMutability: "nonpayable" as const,
    inputs: [
        { name: "wallet", type: "bytes32" as const },
        { name: "mint", type: "bytes32" as const },
    ],
    outputs: [{ name: "", type: "bytes32" as const }],
}] as const;

const cpiAbi = {
    invoke: {
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
    },
    account_info: {
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
    },
} as const;

async function main() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    if (!wallet?.account) throw new Error("No wallet found");

    const bridge = await viem.getContractAt("RomeWormholeBridge", BRIDGE_ADDRESS);

    const pdaHex = await bridge.read.bridgeUserPda() as `0x${string}`;
    const pda = new PublicKey(Buffer.from(pdaHex.slice(2), "hex"));
    console.log("EVM Wallet:", wallet.account.address);
    console.log("Solana PDA:", pda.toBase58(), `(${pdaHex})`);

    const splTokenHex = pkHex(SPL_TOKEN_PK);

    // Step 0: Get Rome EVM program ID
    console.log("\n--- Step 0: Get Rome EVM Program ID ---");
    const romeEvmProgram = await publicClient.readContract({
        address: SYSTEM_PRECOMPILE,
        abi: [systemAbi.rome_evm_program_id],
        functionName: "rome_evm_program_id",
    }) as `0x${string}`;
    console.log("Rome EVM program:", romeEvmProgram);

    // Step 1: Derive what create_account would produce for a given salt
    const salt = "0x00000000000000000000000000000000000000000000000000000000000000ff" as `0x${string}`;
    const userAddrBytes = `0x${wallet.account.address.slice(2).padStart(40, "0")}` as `0x${string}`;

    console.log("\n--- Step 1: Derive mint address ---");
    let mintHex: `0x${string}`;
    try {
        const result = await publicClient.readContract({
            address: SYSTEM_PRECOMPILE,
            abi: [systemAbi.find_program_address],
            functionName: "find_program_address",
            args: [
                romeEvmProgram,
                [
                    { item: userAddrBytes },
                    { item: salt },
                ],
            ],
        });
        mintHex = result[0] as `0x${string}`;
        const mintPk = new PublicKey(Buffer.from(mintHex.slice(2), "hex"));
        console.log("Derived mint address:", mintPk.toBase58());
        console.log("Mint hex:", mintHex);
    } catch (e: any) {
        console.log("find_program_address failed:", e.message?.slice(0, 200));
        return;
    }

    // Step 2: Create the mint account
    console.log("\n--- Step 2: Create mint account ---");
    let mintAlreadyExists = false;
    try {
        const info = await publicClient.readContract({
            address: CPI_PRECOMPILE,
            abi: [cpiAbi.account_info],
            functionName: "account_info",
            args: [mintHex],
        });
        if ((info[5] as string).length > 2) {
            console.log("Mint account already exists! Skipping creation.");
            mintAlreadyExists = true;
        }
    } catch {}

    if (!mintAlreadyExists) {
        try {
            const tx = await wallet.sendTransaction({
                to: SYSTEM_PRECOMPILE,
                data: encodeFunctionData({
                    abi: [systemAbi.create_account],
                    functionName: "create_account",
                    args: [splTokenHex, BigInt(82), wallet.account.address, salt],
                }),
                gas: 5_000_000n,
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
            console.log("create_account TX:", tx, "Status:", receipt.status);
        } catch (e: any) {
            const msg = e.message || "";
            if (msg.includes("existing")) {
                console.log("Already exists, continuing.");
                mintAlreadyExists = true;
            } else {
                console.log("create_account failed:", msg.slice(0, 300));
                return;
            }
        }
    }

    const mintPk = new PublicKey(Buffer.from(mintHex.slice(2), "hex"));

    // Step 3: Initialize mint via CPI (InitializeMint2 = instruction 20)
    console.log("\n--- Step 3: Initialize mint ---");
    // Check if already initialized
    let mintInitialized = false;
    try {
        const info = await publicClient.readContract({
            address: CPI_PRECOMPILE,
            abi: [cpiAbi.account_info],
            functionName: "account_info",
            args: [mintHex],
        });
        const data = info[5] as string;
        // A valid mint has 82 bytes of data with is_initialized at byte offset 45
        if (data.length >= 166) { // 82 bytes = 164 hex chars + 0x
            const initByte = parseInt(data.slice(2 + 90, 2 + 92), 16); // byte 45
            mintInitialized = initByte === 1;
        }
    } catch {}

    if (mintInitialized) {
        console.log("Mint already initialized! Skipping.");
    } else {
        // InitializeMint2: [20, decimals(1), mint_authority(32), option(1) + freeze_authority(32)]
        const initData = new Uint8Array(67);
        initData[0] = 20; // InitializeMint2
        initData[1] = 9;  // 9 decimals
        const pdaBytes = Buffer.from(pdaHex.slice(2), "hex");
        initData.set(pdaBytes, 2); // mint authority = our PDA
        initData[34] = 0; // COption::None for freeze authority

        try {
            const tx = await wallet.sendTransaction({
                to: CPI_PRECOMPILE,
                data: encodeFunctionData({
                    abi: [cpiAbi.invoke],
                    functionName: "invoke",
                    args: [
                        splTokenHex,
                        [{ pubkey: mintHex, is_signer: false, is_writable: true }],
                        `0x${Buffer.from(initData).toString("hex")}` as `0x${string}`,
                    ],
                }),
                gas: 5_000_000n,
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
            console.log("InitializeMint2 TX:", tx, "Status:", receipt.status);
        } catch (e: any) {
            console.log("InitializeMint2 failed:", e.message?.slice(0, 300));
            return;
        }
    }

    // Step 4: Create ATA for PDA
    console.log("\n--- Step 4: Create ATA ---");
    const ata = getAta(mintPk, pda);
    console.log("ATA:", ata.toBase58());

    let ataExists = false;
    try {
        const info = await publicClient.readContract({
            address: CPI_PRECOMPILE,
            abi: [cpiAbi.account_info],
            functionName: "account_info",
            args: [pkHex(ata)],
        });
        ataExists = (info[5] as string).length > 2;
    } catch {}

    if (ataExists) {
        console.log("ATA already exists!");
    } else {
        try {
            const tx = await wallet.sendTransaction({
                to: ASSOC_TOKEN_PRECOMPILE,
                data: encodeFunctionData({
                    abi: assocTokenAbi,
                    functionName: "create_associated_token_account",
                    args: [pdaHex, mintHex],
                }),
                gas: 5_000_000n,
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
            console.log("Create ATA TX:", tx, "Status:", receipt.status);
        } catch (e: any) {
            console.log("Create ATA failed:", e.message?.slice(0, 200));
            return;
        }
    }

    // Step 5: MintTo — mint 1,000 tokens (with 9 decimals)
    console.log("\n--- Step 5: Mint tokens ---");
    const mintAmount = BigInt(1_000_000_000_000); // 1000 tokens with 9 decimals
    const mintToIxData = new Uint8Array(9);
    mintToIxData[0] = 7; // MintTo instruction
    const amtBuf = Buffer.alloc(8);
    amtBuf.writeBigUInt64LE(mintAmount);
    mintToIxData.set(amtBuf, 1);

    try {
        const tx = await wallet.sendTransaction({
            to: CPI_PRECOMPILE,
            data: encodeFunctionData({
                abi: [cpiAbi.invoke],
                functionName: "invoke",
                args: [
                    splTokenHex,
                    [
                        { pubkey: mintHex, is_signer: false, is_writable: true },     // mint
                        { pubkey: pkHex(ata), is_signer: false, is_writable: true },   // destination ATA
                        { pubkey: pdaHex, is_signer: true, is_writable: false },       // mint authority
                    ],
                    `0x${Buffer.from(mintToIxData).toString("hex")}` as `0x${string}`,
                ],
            }),
            gas: 5_000_000n,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        console.log("MintTo TX:", tx, "Status:", receipt.status);
    } catch (e: any) {
        console.log("MintTo failed:", e.message?.slice(0, 300));
        return;
    }

    // Step 6: Check balance
    console.log("\n--- Step 6: Final balance ---");
    try {
        const info = await publicClient.readContract({
            address: CPI_PRECOMPILE,
            abi: [cpiAbi.account_info],
            functionName: "account_info",
            args: [pkHex(ata)],
        });
        const data = info[5] as string;
        if (data.length > 130) {
            const rawHex = data.slice(2);
            const amountBuf = Buffer.from(rawHex.slice(128, 144), "hex");
            const balance = amountBuf.readBigUInt64LE();
            console.log("Token balance:", balance.toString(), `(${Number(balance) / 1e9} tokens)`);
            if (balance > 0n) {
                console.log("\n=== SUCCESS ===");
                console.log("Your PDA now has test tokens!");
                console.log("Mint:", mintPk.toBase58());
                console.log("Mint hex:", mintHex);
                console.log("ATA:", ata.toBase58());
                console.log("\nUpdate wormhole_transfer.ts MINT to:", mintPk.toBase58());
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
