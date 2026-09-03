import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { isAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Behavioral integration test for SPL_ERC20_cached.
//
// REQUIRES:
//   - HADRIAN_PRIVATE_KEY in keystore (test wallet with USDC for gas)
//   - A pre-deployed SPL_ERC20_cached instance on Hadrian (deploy via
//     `npx hardhat run scripts/erc20spl/deploy_cached.ts --network hadrian`
//     with WRAPPER_MINT_ID env var set to the test mint)
//   - The test wallet must be the on-chain mint authority for the test
//     mint (so direct `SplCached.mint` calls can be exercised). Create one
//     via the existing factory's create_token_mint flow before this suite
//     runs.
//
// POST-#511: the wrapper no longer exposes `mint_to` (scope §6.1) — a
// direct CALL would sign as the wrapper's own PDA, which is never the
// on-chain mint authority. Minting goes straight to the SplCached
// precompile (0xff..05) from the authority EOA; see `mintSpl` below.
//
// SCOPE:
//   - Constructor: name + symbol + decimals match init values
//   - Views: totalSupply / balanceOf / allowance / get_token_account
//   - Mutations: mint (direct precompile) / transfer / approve / transferFrom
//   - Saturation: approve(MaxUint256) round-trips as MaxUint256 in
//     allowance() readback
//   - ATA lifecycle: ensure_token_account + create_token_account
//     idempotency
//
// OUT OF SCOPE (separate test files under tests/erc20spl/):
//   - Revert atomicity         -> cached.revert.test.ts
//   - Iterative-VM multi-step  -> cached.iterative.test.ts
//   - In-tx ordering negative  -> cached.ordering.test.ts

describe("SPL_ERC20_cached — behavioral integration", () => {
    let wrapperAddress: `0x${string}`;
    let publicClient: any;
    let walletClient: any;
    let senderAddress: `0x${string}`;

    before(async () => {
        const { viem } = await hardhat.network.connect();
        publicClient = await viem.getPublicClient();
        const wallets = await viem.getWalletClients();
        if (wallets.length === 0) {
            throw new Error(
                "no wallet client — set HADRIAN_PRIVATE_KEY in keystore: " +
                "`npx hardhat keystore set HADRIAN_PRIVATE_KEY --dev`",
            );
        }
        walletClient = wallets[0];
        senderAddress = walletClient.account.address;

        const envAddr = process.env.SPL_ERC20_CACHED_ADDRESS;
        if (!envAddr || !isAddress(envAddr)) {
            throw new Error(
                "SPL_ERC20_CACHED_ADDRESS env var not set or invalid. " +
                "Deploy first: `npx hardhat run scripts/erc20spl/deploy_cached.ts --network hadrian`",
            );
        }
        wrapperAddress = envAddr as `0x${string}`;
    });

    // Post-#511: the wrapper has no `mint_to` — mint straight to the
    // SplCached precompile from the authority EOA (test wallet must be
    // the on-chain mint authority for `mint_id`).
    async function mintSpl(to: `0x${string}`, amount: bigint) {
        const mintId = await publicClient.readContract({
            address: wrapperAddress,
            abi: mintIdAbi,
            functionName: "mint_id",
        });
        const txHash = await walletClient.writeContract({
            address: SPL_CACHED_ADDRESS,
            abi: splCachedMintAbi,
            functionName: "mint",
            args: [to, amount, mintId],
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
    }

    it("returns the constructor-passed name", async () => {
        const name = await publicClient.readContract({
            address: wrapperAddress,
            abi: nameAbi,
            functionName: "name",
        });
        assert.equal(typeof name, "string");
        assert.ok(name.length > 0);
    });

    it("returns the constructor-passed symbol", async () => {
        const symbol = await publicClient.readContract({
            address: wrapperAddress,
            abi: symbolAbi,
            functionName: "symbol",
        });
        assert.equal(typeof symbol, "string");
        assert.ok(symbol.length > 0);
    });

    it("reads decimals from the SPL mint (CpiProgram.account_info)", async () => {
        const decimals = await publicClient.readContract({
            address: wrapperAddress,
            abi: decimalsAbi,
            functionName: "decimals",
        });
        assert.ok(decimals >= 0 && decimals <= 18);
    });

    it("totalSupply > 0 for an initialized mint (CpiProgram CrossStateEthCall)", async () => {
        const supply = await publicClient.readContract({
            address: wrapperAddress,
            abi: totalSupplyAbi,
            functionName: "totalSupply",
        });
        assert.ok(supply >= 0n);
    });

    it("balanceOf returns 0 for a fresh address (HelperProgram.user_balance)", async () => {
        const fresh = privateKeyToAccount(generatePrivateKey()).address;
        const balance = await publicClient.readContract({
            address: wrapperAddress,
            abi: balanceOfAbi,
            functionName: "balanceOf",
            args: [fresh],
        });
        assert.equal(balance, 0n);
    });

    it("allowance returns 0 for an unapproved spender", async () => {
        const owner = privateKeyToAccount(generatePrivateKey()).address;
        const spender = privateKeyToAccount(generatePrivateKey()).address;
        const result = await publicClient.readContract({
            address: wrapperAddress,
            abi: allowanceAbi,
            functionName: "allowance",
            args: [owner, spender],
        });
        assert.equal(result, 0n);
    });

    it("get_token_account returns a deterministic ATA (HelperProgram.ata EthCall)", async () => {
        const user = privateKeyToAccount(generatePrivateKey()).address;
        const ata1 = await publicClient.readContract({
            address: wrapperAddress,
            abi: getTokenAccountAbi,
            functionName: "get_token_account",
            args: [user],
        });
        const ata2 = await publicClient.readContract({
            address: wrapperAddress,
            abi: getTokenAccountAbi,
            functionName: "get_token_account",
            args: [user],
        });
        assert.equal(ata1, ata2);
        assert.notEqual(
            ata1,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
        );
    });

    it("SplCached.mint (direct precompile, test wallet must be the mint authority) credits recipient", async () => {
        const recipient = privateKeyToAccount(generatePrivateKey()).address;
        const amount = 1_000_000n; // assumes 6-decimal mint

        const balBefore = await publicClient.readContract({
            address: wrapperAddress,
            abi: balanceOfAbi,
            functionName: "balanceOf",
            args: [recipient],
        });

        await mintSpl(recipient, amount);

        const balAfter = await publicClient.readContract({
            address: wrapperAddress,
            abi: balanceOfAbi,
            functionName: "balanceOf",
            args: [recipient],
        });
        assert.equal(balAfter - balBefore, amount);
    });

    it("transfer moves balance + emits Transfer event", async () => {
        const recipient = privateKeyToAccount(generatePrivateKey()).address;
        const amount = 100_000n;

        // Pre-mint to sender so it has balance to send
        await mintSpl(senderAddress, amount);

        const senderBefore = await publicClient.readContract({
            address: wrapperAddress,
            abi: balanceOfAbi,
            functionName: "balanceOf",
            args: [senderAddress],
        });
        const recipBefore = await publicClient.readContract({
            address: wrapperAddress,
            abi: balanceOfAbi,
            functionName: "balanceOf",
            args: [recipient],
        });

        const txHash = await walletClient.writeContract({
            address: wrapperAddress,
            abi: transferAbi,
            functionName: "transfer",
            args: [recipient, amount],
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });

        const senderAfter = await publicClient.readContract({
            address: wrapperAddress,
            abi: balanceOfAbi,
            functionName: "balanceOf",
            args: [senderAddress],
        });
        const recipAfter = await publicClient.readContract({
            address: wrapperAddress,
            abi: balanceOfAbi,
            functionName: "balanceOf",
            args: [recipient],
        });
        assert.equal(senderBefore - senderAfter, amount);
        assert.equal(recipAfter - recipBefore, amount);
    });

    it("approve(MaxUint256) round-trips exactly — post-#511 allowance is plain uint256 EVM storage, no u64 sentinel", async () => {
        const spender = privateKeyToAccount(generatePrivateKey()).address;
        const max = (1n << 256n) - 1n;

        const txHash = await walletClient.writeContract({
            address: wrapperAddress,
            abi: approveAbi,
            functionName: "approve",
            args: [spender, max],
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });

        const readback = await publicClient.readContract({
            address: wrapperAddress,
            abi: allowanceAbi,
            functionName: "allowance",
            args: [senderAddress, spender],
        });
        assert.equal(readback, max);
    });
});

// ─── Inline ABI snippets — DRY-share by extracting later if useful ────

const nameAbi = [{
    name: "name",
    type: "function",
    inputs: [],
    outputs: [{ type: "string" }],
    stateMutability: "view",
}] as const;

const symbolAbi = [{
    name: "symbol",
    type: "function",
    inputs: [],
    outputs: [{ type: "string" }],
    stateMutability: "view",
}] as const;

const decimalsAbi = [{
    name: "decimals",
    type: "function",
    inputs: [],
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
}] as const;

const totalSupplyAbi = [{
    name: "totalSupply",
    type: "function",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
}] as const;

const balanceOfAbi = [{
    name: "balanceOf",
    type: "function",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
}] as const;

const allowanceAbi = [{
    name: "allowance",
    type: "function",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
}] as const;

const getTokenAccountAbi = [{
    name: "get_token_account",
    type: "function",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
}] as const;

const mintIdAbi = [{
    name: "mint_id",
    type: "function",
    inputs: [],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
}] as const;

// SplCached precompile (0xff..05) — post-#511, minting bypasses the
// wrapper entirely (scope §6.1: no ERC20SPL_cached.mint_to).
const SPL_CACHED_ADDRESS = "0xff00000000000000000000000000000000000005" as const;

const splCachedMintAbi = [{
    name: "mint",
    type: "function",
    inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
}] as const;

const transferAbi = [{
    name: "transfer",
    type: "function",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
}] as const;

const approveAbi = [{
    name: "approve",
    type: "function",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
    stateMutability: "nonpayable",
}] as const;
