/**
 * Hadrian smoke for the production hook-aware wrapper path:
 * factory -> SPL_ERC20_Token2022Hooked -> generic CPI -> Token-2022 -> hook.
 *
 * Required environment (public fixture identifiers only):
 *   LEAF2_MINT, LEAF2_HOOK_PROGRAM, LEAF2_VALIDATION
 * Signing material is loaded from the established local test wallet file and
 * is never printed or written to evidence.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import {
    createPublicClient,
    createWalletClient,
    http,
    type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const HADRIAN_RPC = "https://hadrian.testnet.romeprotocol.xyz/";
const CPI = "0xff00000000000000000000000000000000000008" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const AMOUNT = 1_000n;

const factoryAbi = [
    { type: "function", name: "add_spl_token_no_metadata", stateMutability: "nonpayable", inputs: [{ type: "bytes32", name: "mint" }, { type: "string", name: "name" }, { type: "string", name: "symbol" }], outputs: [{ type: "address" }] },
    { type: "function", name: "token_by_mint", stateMutability: "view", inputs: [{ type: "bytes32", name: "mint" }], outputs: [{ type: "address" }] },
    { type: "function", name: "wrapper_kind_by_mint", stateMutability: "view", inputs: [{ type: "bytes32", name: "mint" }], outputs: [{ type: "uint8" }] },
] as const;
const wrapperAbi = [
    { type: "error", name: "HookAccountPlanRequired", inputs: [] },
    { type: "function", name: "get_token_account", stateMutability: "view", inputs: [{ type: "address", name: "user" }], outputs: [{ type: "bytes32" }] },
    { type: "function", name: "hook_program", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
    { type: "function", name: "validation_account", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
    { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "value" }], outputs: [{ type: "bool" }] },
    { type: "function", name: "transferWithHookAccounts", stateMutability: "nonpayable", inputs: [
        { type: "address", name: "to" },
        { type: "uint256", name: "value" },
        { type: "tuple[]", name: "hookMetas", components: [{ type: "bytes32", name: "pubkey" }, { type: "bool", name: "is_signer" }, { type: "bool", name: "is_writable" }] },
    ], outputs: [{ type: "bool" }] },
] as const;

function envPublicKey(name: string): PublicKey {
    const raw = process.env[name];
    if (!raw) throw new Error(`${name} is required`);
    return new PublicKey(raw);
}

function bytes32(key: PublicKey): `0x${string}` {
    return `0x${Buffer.from(key.toBytes()).toString("hex")}`;
}

function publicKey(key: `0x${string}`): PublicKey {
    return new PublicKey(Buffer.from(key.slice(2), "hex"));
}

function artifact(path: string): { abi: readonly unknown[]; bytecode: Hex } {
    return JSON.parse(readFileSync(join(process.cwd(), path), "utf8"));
}

async function gasPrice(): Promise<bigint> {
    const response = await fetch(HADRIAN_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
    });
    const payload = await response.json() as { result?: Hex; error?: unknown };
    if (!payload.result) throw new Error(`eth_gasPrice failed: ${JSON.stringify(payload.error)}`);
    return (BigInt(payload.result) * 12n) / 10n;
}

async function tokenAmount(connection: Connection, ata: PublicKey): Promise<bigint> {
    const info = await connection.getAccountInfo(ata, "confirmed");
    if (!info) return 0n;
    assert.ok(info.data.length >= 72, "token account data too short");
    return info.data.readBigUInt64LE(64);
}

async function main(): Promise<void> {
    const mint = envPublicKey("LEAF2_MINT");
    const hook = envPublicKey("LEAF2_HOOK_PROGRAM");
    const validation = envPublicKey("LEAF2_VALIDATION");
    const solanaRpc = readFileSync(
        join(homedir(), ".rome-test-wallets", "solana-devnet-rpc"),
        "utf8",
    ).trim();
    const solana = new Connection(solanaRpc, "confirmed");
    const issuer = privateKeyToAccount(
        readFileSync(join(homedir(), ".rome-test-wallets", "evm.key"), "utf8").trim() as Hex,
    );
    const recipient = privateKeyToAccount(generatePrivateKey());
    const publicClient = createPublicClient({ transport: http(HADRIAN_RPC) });
    const walletClient = createWalletClient({ account: issuer, transport: http(HADRIAN_RPC) });
    const options = { account: issuer, gasPrice: await gasPrice() };

    const factoryArtifact = artifact(
        "artifacts/contracts/erc20spl/erc20spl_factory.sol/ERC20SPLFactory.json",
    );
    const factoryDeployHash = await walletClient.deployContract({
        ...options,
        abi: factoryArtifact.abi,
        bytecode: factoryArtifact.bytecode,
        args: [CPI],
    });
    const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryDeployHash });
    assert.equal(factoryReceipt.status, "success");
    assert.ok(factoryReceipt.contractAddress);

    const registerHash = await walletClient.writeContract({
        ...options,
        address: factoryReceipt.contractAddress,
        abi: factoryAbi,
        functionName: "add_spl_token_no_metadata",
        args: [bytes32(mint), "Leaf 2 Hook Fixture", "L2HOOK"],
    });
    assert.equal((await publicClient.waitForTransactionReceipt({ hash: registerHash })).status, "success");
    const wrapper = await publicClient.readContract({
        address: factoryReceipt.contractAddress,
        abi: factoryAbi,
        functionName: "token_by_mint",
        args: [bytes32(mint)],
    });
    assert.notEqual(wrapper, ZERO);
    const kind = await publicClient.readContract({
        address: factoryReceipt.contractAddress,
        abi: factoryAbi,
        functionName: "wrapper_kind_by_mint",
        args: [bytes32(mint)],
    });
    assert.equal(kind, 2);
    assert.equal(await publicClient.readContract({ address: wrapper, abi: wrapperAbi, functionName: "hook_program" }), bytes32(hook));
    assert.equal(await publicClient.readContract({ address: wrapper, abi: wrapperAbi, functionName: "validation_account" }), bytes32(validation));

    const sourceAta = publicKey(await publicClient.readContract({
        address: wrapper,
        abi: wrapperAbi,
        functionName: "get_token_account",
        args: [issuer.address],
    }));
    const recipientAta = publicKey(await publicClient.readContract({
        address: wrapper,
        abi: wrapperAbi,
        functionName: "get_token_account",
        args: [recipient.address],
    }));
    const sourceBefore = await tokenAmount(solana, sourceAta);
    const recipientBefore = await tokenAmount(solana, recipientAta);
    assert.ok(sourceBefore >= AMOUNT, "fixture issuer balance is insufficient");

    let standardTransferFailure = "";
    try {
        await walletClient.writeContract({
            ...options,
            address: wrapper,
            abi: wrapperAbi,
            functionName: "transfer",
            args: [recipient.address, AMOUNT],
        });
        throw new Error("standard transfer unexpectedly succeeded");
    } catch (error) {
        if (error instanceof Error && error.message === "standard transfer unexpectedly succeeded") throw error;
        standardTransferFailure = error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600);
        assert.match(standardTransferFailure, /HookAccountPlanRequired/);
    }
    assert.equal(await tokenAmount(solana, sourceAta), sourceBefore);
    assert.equal(await tokenAmount(solana, recipientAta), recipientBefore);

    // This fixture has an empty ExtraAccountMetaList. The complete official
    // trailer is therefore hook program + validation PDA.
    const hookMetas = [
        { pubkey: bytes32(hook), is_signer: false, is_writable: false },
        { pubkey: bytes32(validation), is_signer: false, is_writable: false },
    ];
    const transferHash = await walletClient.writeContract({
        ...options,
        address: wrapper,
        abi: wrapperAbi,
        functionName: "transferWithHookAccounts",
        args: [recipient.address, AMOUNT, hookMetas],
    });
    const transferReceipt = await publicClient.waitForTransactionReceipt({ hash: transferHash });
    assert.equal(transferReceipt.status, "success");
    const sourceAfter = await tokenAmount(solana, sourceAta);
    const recipientAfter = await tokenAmount(solana, recipientAta);
    assert.equal(sourceAfter, sourceBefore - AMOUNT);
    assert.equal(recipientAfter, recipientBefore + AMOUNT);

    const evidence = {
        status: "pass",
        scope: "factory-created SPL_ERC20_Token2022Hooked on Hadrian",
        mint: mint.toBase58(),
        hookProgram: hook.toBase58(),
        validation: validation.toBase58(),
        factory: factoryReceipt.contractAddress,
        wrapper,
        wrapperKind: Number(kind),
        transactions: { factoryDeploy: factoryDeployHash, register: registerHash, hookedTransfer: transferHash },
        standardTransfer: { rejected: true, balancesUnchanged: true, detail: standardTransferFailure },
        balances: {
            sourceAta: sourceAta.toBase58(),
            recipientAta: recipientAta.toBase58(),
            sourceBefore: sourceBefore.toString(),
            sourceAfter: sourceAfter.toString(),
            recipientBefore: recipientBefore.toString(),
            recipientAfter: recipientAfter.toString(),
        },
    };
    mkdirSync("evidence", { recursive: true });
    const evidencePath = `evidence/leaf2-token2022-production-wrapper-hadrian-${Date.now()}.json`;
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ ...evidence, evidence: evidencePath }, null, 2));
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
