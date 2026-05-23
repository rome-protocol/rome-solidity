// Direct Solana-side simulation of the Meteora swap ix that mollusk reports
// PrivilegeEscalation on.
//
// Strategy:
//   - Read all the pool/vault/ATA addresses from the wrapped pool contract
//   - Construct the 15-account swap ix manually
//   - simulateTransaction against Solana devnet with sigVerify: false
//
// If Solana accepts it: mollusk emulator bug (Rome-side fix)
// If Solana rejects it: real account-flag mismatch (Solidity-side fix)
import hardhat from "hardhat";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction } from "@solana/web3.js";
import { getAddress, parseAbi } from "viem";

const SOLANA_RPC = "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";
const HADRIAN_RPC = "https://hadrian.testnet.romeprotocol.xyz/";

const POOL_WRAPPER = "0x4B7EB70311fD0752d270Ca1017CC49845c305321" as const; // ERC20DAMMv1Pool wrapper
const USER_EVM = "0x1f4946Be340F06c46A50E65084790968aBcc48F6" as const;
const W_USDC = "0x9fD4D58dbB041CaFF77d323d2410c16DE339eB18" as const;
const W_SOL = "0x28E7c064E734cB3edeA65A98927c1c20581c8934" as const;

const HELPER = "0xff00000000000000000000000000000000000009" as const;
const DAMM_PROGRAM_BS58 = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB";
const VAULT_PROGRAM_BS58 = "24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function bytes32ToPubkey(hex: string): PublicKey {
    const h = hex.startsWith("0x") ? hex.slice(2) : hex;
    return new PublicKey(Buffer.from(h, "hex"));
}

async function main() {
    const { viem } = await hardhat.network.connect() as any;
    const pc = await viem.getPublicClient();
    const conn = new Connection(SOLANA_RPC, "confirmed");

    // Read pool state via wrapped pool contract
    // Solidity public getter for a struct returns only non-struct fields
    // (skips nested structs `bumps` and `locked_profit_tracker`). So vault_a
    // returns: (enabled, total_amount, token_vault, fee_vault, token_mint, lp_mint)
    const poolAbi = parseAbi([
        "function pool_address() view returns (bytes32)",
        "function token_a_mint() view returns (bytes32)",
        "function token_b_mint() view returns (bytes32)",
        "function a_vault() view returns (bytes32)",
        "function b_vault() view returns (bytes32)",
        "function a_vault_lp() view returns (bytes32)",
        "function b_vault_lp() view returns (bytes32)",
        "function protocol_token_a_fee() view returns (bytes32)",
        "function protocol_token_b_fee() view returns (bytes32)",
        "function vault_a() view returns (uint8 enabled, uint64 total_amount, bytes32 token_vault, bytes32 fee_vault, bytes32 token_mint, bytes32 lp_mint)",
        "function vault_b() view returns (uint8 enabled, uint64 total_amount, bytes32 token_vault, bytes32 fee_vault, bytes32 token_mint, bytes32 lp_mint)",
    ]);

    // ERC20DAMMv1Pool exposes the same fields as internal DAMMv1Pool
    const poolImpl = await viem.getContractAt("ERC20DAMMv1Pool", POOL_WRAPPER);
    const internalAddr = await poolImpl.read.internal_pool();
    console.log(`internal pool contract: ${internalAddr}`);

    const pool = bytes32ToPubkey(await pc.readContract({ address: internalAddr, abi: poolAbi, functionName: "pool_address" }) as string);
    const tokenAMint = bytes32ToPubkey(await pc.readContract({ address: internalAddr, abi: poolAbi, functionName: "token_a_mint" }) as string);
    const tokenBMint = bytes32ToPubkey(await pc.readContract({ address: internalAddr, abi: poolAbi, functionName: "token_b_mint" }) as string);
    const aVault = bytes32ToPubkey(await pc.readContract({ address: internalAddr, abi: poolAbi, functionName: "a_vault" }) as string);
    const bVault = bytes32ToPubkey(await pc.readContract({ address: internalAddr, abi: poolAbi, functionName: "b_vault" }) as string);
    const aVaultLp = bytes32ToPubkey(await pc.readContract({ address: internalAddr, abi: poolAbi, functionName: "a_vault_lp" }) as string);
    const bVaultLp = bytes32ToPubkey(await pc.readContract({ address: internalAddr, abi: poolAbi, functionName: "b_vault_lp" }) as string);
    const protoTokenAFee = bytes32ToPubkey(await pc.readContract({ address: internalAddr, abi: poolAbi, functionName: "protocol_token_a_fee" }) as string);
    // vault_a/b tuple: [enabled, total_amount, token_vault, fee_vault, token_mint, lp_mint]
    const vaultATuple = await pc.readContract({ address: internalAddr, abi: poolAbi, functionName: "vault_a" }) as any[];
    const vaultBTuple = await pc.readContract({ address: internalAddr, abi: poolAbi, functionName: "vault_b" }) as any[];
    const aTokenVault = bytes32ToPubkey(vaultATuple[2]);
    const bTokenVault = bytes32ToPubkey(vaultBTuple[2]);
    const aVaultLpMint = bytes32ToPubkey(vaultATuple[5]);
    const bVaultLpMint = bytes32ToPubkey(vaultBTuple[5]);
    console.log(`pool:          ${pool.toBase58()}`);
    console.log(`tokenA mint:   ${tokenAMint.toBase58()}`);
    console.log(`tokenB mint:   ${tokenBMint.toBase58()}`);
    console.log(`a_vault_lp_mint: ${aVaultLpMint.toBase58()}`);
    console.log(`b_vault_lp_mint: ${bVaultLpMint.toBase58()}`);

    // Read user's PDA + source/dest ATAs via helper precompile
    const helperAbi = parseAbi([
        "function pda(address user) view returns (bytes32)",
        "function ata(address user, bytes32 mint) view returns (bytes32)",
    ]);
    const userPda = bytes32ToPubkey(await pc.readContract({ address: HELPER, abi: helperAbi, functionName: "pda", args: [USER_EVM] }) as string);
    const userUsdcAta = bytes32ToPubkey(await pc.readContract({ address: HELPER, abi: helperAbi, functionName: "ata", args: [USER_EVM, await pc.readContract({ address: internalAddr, abi: poolAbi, functionName: "token_a_mint" }) as `0x${string}`] }) as string);
    const userSolAta = bytes32ToPubkey(await pc.readContract({ address: HELPER, abi: helperAbi, functionName: "ata", args: [USER_EVM, await pc.readContract({ address: internalAddr, abi: poolAbi, functionName: "token_b_mint" }) as `0x${string}`] }) as string);
    console.log(`user PDA: ${userPda.toBase58()}`);
    console.log(`user USDC ATA: ${userUsdcAta.toBase58()}`);
    console.log(`user SOL  ATA: ${userSolAta.toBase58()}`);

    // Build the 15-account swap ix per Anchor IDL ordering
    const accounts = [
        { pubkey: pool,                    isSigner: false, isWritable: true },
        { pubkey: userUsdcAta,             isSigner: false, isWritable: true },
        { pubkey: userSolAta,              isSigner: false, isWritable: true },
        { pubkey: aVault,                  isSigner: false, isWritable: true },
        { pubkey: bVault,                  isSigner: false, isWritable: true },
        { pubkey: aTokenVault,             isSigner: false, isWritable: true },
        { pubkey: bTokenVault,             isSigner: false, isWritable: true },
        { pubkey: aVaultLpMint,            isSigner: false, isWritable: true },
        { pubkey: bVaultLpMint,            isSigner: false, isWritable: true },
        { pubkey: aVaultLp,                isSigner: false, isWritable: true },
        { pubkey: bVaultLp,                isSigner: false, isWritable: true },
        { pubkey: protoTokenAFee,          isSigner: false, isWritable: true },
        { pubkey: userPda,                 isSigner: true,  isWritable: false },
        { pubkey: new PublicKey(VAULT_PROGRAM_BS58),  isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM,                       isSigner: false, isWritable: false },
    ];

    // Anchor swap discriminator: sha256("global:swap")[..8]
    const crypto = await import("crypto");
    const disc = crypto.createHash("sha256").update("global:swap").digest().subarray(0, 8);
    // Swap ix data: discriminator + in_amount (u64 LE) + minimum_out_amount (u64 LE)
    const inAmount = 10_000n;
    const minOut = 1n;
    const dataBuf = Buffer.concat([
        disc,
        Buffer.from(new BigUint64Array([inAmount]).buffer),
        Buffer.from(new BigUint64Array([minOut]).buffer),
    ]);

    const ix = new TransactionInstruction({
        programId: new PublicKey(DAMM_PROGRAM_BS58),
        keys: accounts,
        data: dataBuf,
    });

    const payer = Keypair.generate();  // simulation only, sigVerify: false
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions: [ix],
    }).compileToV0Message();
    const vtx = new VersionedTransaction(msg);
    // Sign with a throwaway key — sigVerify: false bypasses real check
    vtx.sign([payer]);

    console.log(`\n=== Solana simulateTransaction (sigVerify: false) ===`);
    const sim = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true });
    console.log(`err:`, sim.value.err);
    if (sim.value.logs) {
        console.log(`\nlogs (last 30):`);
        for (const l of sim.value.logs.slice(-30)) console.log(`  ${l}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
