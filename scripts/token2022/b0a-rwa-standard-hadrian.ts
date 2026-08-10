import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const CPI = "0xff00000000000000000000000000000000000008" as const;
const TRANSFER_AMOUNT = 1_000_000n;

const factoryAbi = [
    { type: "function", name: "add_rwa_standard_token_no_metadata", stateMutability: "nonpayable", inputs: [{ type: "bytes32", name: "mint" }, { type: "string", name: "name" }, { type: "string", name: "symbol" }], outputs: [{ type: "address" }] },
    { type: "function", name: "token_by_mint", stateMutability: "view", inputs: [{ type: "bytes32", name: "mint" }], outputs: [{ type: "address" }] },
    { type: "function", name: "wrapper_kind_by_mint", stateMutability: "view", inputs: [{ type: "bytes32", name: "mint" }], outputs: [{ type: "uint8" }] },
] as const;

const wrapperAbi = [
    { type: "function", name: "get_token_account", stateMutability: "view", inputs: [{ type: "address", name: "user" }], outputs: [{ type: "bytes32" }] },
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address", name: "spender" }, { type: "uint256", name: "value" }], outputs: [{ type: "bool" }] },
    { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }, { type: "uint256", name: "value" }], outputs: [{ type: "bool" }] },
    { type: "function", name: "transferFrom", stateMutability: "nonpayable", inputs: [{ type: "address", name: "from" }, { type: "address", name: "to" }, { type: "uint256", name: "value" }], outputs: [{ type: "bool" }] },
] as const;

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function artifact(path: string): { abi: readonly unknown[]; bytecode: Hex } {
    return JSON.parse(readFileSync(join(process.cwd(), path), "utf8"));
}

function mintBytes32(mint: string): `0x${string}` {
    return `0x${Buffer.from(new PublicKey(mint).toBytes()).toString("hex")}`;
}

function solanaKey(value: `0x${string}`): PublicKey {
    return new PublicKey(Buffer.from(value.slice(2), "hex"));
}

function holderPrivateKey(path: string): Hex {
    const match = readFileSync(path, "utf8").match(/0x[0-9a-fA-F]{64}/);
    if (!match) throw new Error("B0a holder key file does not contain an EVM private key");
    return match[0] as Hex;
}

function deployerPrivateKey(path: string): Hex {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { privateKey?: string };
    if (!parsed.privateKey || !/^(0x)?[0-9a-fA-F]{64}$/.test(parsed.privateKey)) {
        throw new Error("B0a deployer file has no EVM private key");
    }
    return (parsed.privateKey.startsWith("0x") ? parsed.privateKey : `0x${parsed.privateKey}`) as Hex;
}

async function gasPrice(rpc: string): Promise<bigint> {
    const client = createPublicClient({ transport: http(rpc) });
    return (await client.getGasPrice()) * 12n / 10n;
}

async function tokenAmount(connection: Connection, account: PublicKey): Promise<bigint> {
    const info = await connection.getAccountInfo(account, "confirmed");
    assert.ok(info, `missing Token-2022 account ${account.toBase58()}`);
    return info.data.readBigUInt64LE(64);
}

async function main(): Promise<void> {
    const hadrianRpc = required("HADRIAN_RPC");
    const solanaRpc = required("SOLANA_RPC");
    const mint = required("B0A_MINT");
    const deployer = privateKeyToAccount(deployerPrivateKey(required("B0A_DEPLOYER_JSON_PATH")));
    const holder = privateKeyToAccount(holderPrivateKey(required("B0A_HOLDER_KEY_PATH")));
    const transport = http(hadrianRpc, { timeout: 60_000 });
    const publicClient = createPublicClient({ transport });
    const deployerClient = createWalletClient({ account: deployer, transport });
    const holderClient = createWalletClient({ account: holder, transport });
    const options = { gasPrice: await gasPrice(hadrianRpc) };

    const existingFactory = process.env.B0A_FACTORY as `0x${string}` | undefined;
    let factoryDeploy: `0x${string}` | undefined;
    let factory: `0x${string}`;
    if (existingFactory) {
        factory = existingFactory;
    } else {
        const factoryArtifact = artifact("artifacts/contracts/erc20spl/erc20spl_factory.sol/ERC20SPLFactory.json");
        factoryDeploy = await deployerClient.deployContract({
            ...options, abi: factoryArtifact.abi, bytecode: factoryArtifact.bytecode, args: [CPI],
        });
        const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryDeploy });
        assert.equal(factoryReceipt.status, "success");
        assert.ok(factoryReceipt.contractAddress, "factory deployment has no address");
        factory = factoryReceipt.contractAddress;
    }

    const mintId = mintBytes32(mint);
    const existingWrapper = process.env.B0A_WRAPPER as `0x${string}` | undefined;
    let register: `0x${string}` | undefined;
    let wrapper: `0x${string}`;
    if (existingWrapper) {
        wrapper = existingWrapper;
    } else {
        register = await deployerClient.writeContract({
            ...options, address: factory, abi: factoryAbi,
            functionName: "add_rwa_standard_token_no_metadata",
            args: [mintId, "Rome B0a Fixture", "RB0A"],
        });
        assert.equal((await publicClient.waitForTransactionReceipt({ hash: register })).status, "success");
        wrapper = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "token_by_mint", args: [mintId] });
        assert.notEqual(wrapper, "0x0000000000000000000000000000000000000000");
        assert.equal(await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "wrapper_kind_by_mint", args: [mintId] }), 3);
    }

    const sourceAta = solanaKey(await publicClient.readContract({ address: wrapper, abi: wrapperAbi, functionName: "get_token_account", args: [holder.address] }));
    const recipientAta = solanaKey(await publicClient.readContract({ address: wrapper, abi: wrapperAbi, functionName: "get_token_account", args: [deployer.address] }));
    const solana = new Connection(solanaRpc, "confirmed");
    const sourceBefore = await tokenAmount(solana, sourceAta);
    const recipientBefore = await tokenAmount(solana, recipientAta);
    assert.ok(sourceBefore >= TRANSFER_AMOUNT, "holder fixture balance is insufficient");

    let approve: `0x${string}` | undefined;
    let transfer: `0x${string}` | undefined;
    if (process.env.B0A_EXPECT_FROZEN === "1") {
        let rejected = false;
        try {
            transfer = await holderClient.writeContract({
                ...options, address: wrapper, abi: wrapperAbi, functionName: "transfer", args: [deployer.address, TRANSFER_AMOUNT],
            });
            const receipt = await publicClient.waitForTransactionReceipt({ hash: transfer });
            rejected = receipt.status === "reverted";
        } catch {
            rejected = true;
        }
        assert.ok(rejected, "frozen native account unexpectedly permitted EVM transfer");
        assert.equal(await tokenAmount(solana, sourceAta), sourceBefore);
        assert.equal(await tokenAmount(solana, recipientAta), recipientBefore);
    } else if (process.env.B0A_TRANSFER_FROM === "1") {
        approve = await holderClient.writeContract({
            ...options, address: wrapper, abi: wrapperAbi, functionName: "approve", args: [deployer.address, TRANSFER_AMOUNT],
        });
        assert.equal((await publicClient.waitForTransactionReceipt({ hash: approve })).status, "success");
        transfer = await deployerClient.writeContract({
            ...options, address: wrapper, abi: wrapperAbi, functionName: "transferFrom", args: [holder.address, deployer.address, TRANSFER_AMOUNT],
        });
        assert.equal((await publicClient.waitForTransactionReceipt({ hash: transfer })).status, "success");
        assert.equal(await tokenAmount(solana, sourceAta), sourceBefore - TRANSFER_AMOUNT);
        assert.equal(await tokenAmount(solana, recipientAta), recipientBefore + TRANSFER_AMOUNT);
    } else {
        transfer = await holderClient.writeContract({
            ...options, address: wrapper, abi: wrapperAbi, functionName: "transfer", args: [deployer.address, TRANSFER_AMOUNT],
        });
        assert.equal((await publicClient.waitForTransactionReceipt({ hash: transfer })).status, "success");
        assert.equal(await tokenAmount(solana, sourceAta), sourceBefore - TRANSFER_AMOUNT);
        assert.equal(await tokenAmount(solana, recipientAta), recipientBefore + TRANSFER_AMOUNT);
    }

    console.log(JSON.stringify({ status: "pass", expectedFrozen: process.env.B0A_EXPECT_FROZEN === "1", transferFrom: process.env.B0A_TRANSFER_FROM === "1", factory, wrapper, holder: holder.address, sourceAta: sourceAta.toBase58(), recipient: deployer.address, recipientAta: recipientAta.toBase58(), transactions: { factoryDeploy, register, approve, transfer } }, null, 2));
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
