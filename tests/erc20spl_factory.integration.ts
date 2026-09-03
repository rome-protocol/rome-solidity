import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import {
    createWalletClient,
    getAddress,
    isAddress,
    keccak256,
    stringToHex,
    zeroAddress,
    custom
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readDeployments } from "../scripts/lib/deployments.js";

// #511: `SPL_ERC20.mint_to` is DELETED (a direct CALL would sign as the
// wrapper's own PDA, which is not the on-chain mint authority). Minting is
// now a creator/operator act sent directly by the mint authority to
// HelperProgram (0xff..09) — never through the wrapper.
const HELPER_PROGRAM = "0xff00000000000000000000000000000000000009" as const;
const MINT_SPL_ABI = [
    {
        type: "function",
        name: "mint_spl",
        stateMutability: "nonpayable",
        inputs: [
            { name: "to", type: "address" },
            { name: "value", type: "uint64" },
            { name: "mint", type: "bytes32" },
        ],
        outputs: [],
    },
] as const;

async function mintSpl(
    walletClient: { writeContract: (args: unknown) => Promise<`0x${string}`> },
    account: unknown,
    to: `0x${string}`,
    value: bigint,
    mint: `0x${string}`,
): Promise<`0x${string}`> {
    return walletClient.writeContract({
        address: HELPER_PROGRAM,
        abi: MINT_SPL_ABI,
        functionName: "mint_spl",
        args: [to, value, mint],
        account,
    });
}

function resolveFactoryAddress(networkName: string): `0x${string}` {
    const address = readDeployments(networkName).ERC20SPLFactory?.address;

    if (!address) {
        throw new Error(
            `ERC20SPLFactory is not deployed for ${networkName}. Run the deployment script first.`,
        );
    }

    if (!isAddress(address)) {
        throw new Error(`Invalid ERC20SPLFactory address in deployments/${networkName}.json: ${address}`);
    }

    return getAddress(address);
}

function isHex32(value: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(value);
}

async function waitForSuccess(
    publicClient: {
        waitForTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<{ status: string }>;
    },
    txHash: `0x${string}`,
    label: string,
): Promise<void> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    assert.equal(receipt.status, "success", `${label} transaction failed`);
}

async function expectWriteToFail(
    send: () => Promise<`0x${string}`>,
    publicClient: {
        waitForTransactionReceipt: (args: { hash: `0x${string}` }) => Promise<{ status: string }>;
    },
): Promise<void> {
    try {
        const txHash = await send();
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        assert.notEqual(receipt.status, "success", "transaction unexpectedly succeeded");
    } catch {
        return;
    }

    assert.fail("Expected transaction to fail");
}

describe("ERC20SPLFactory integration", { concurrency: false }, function () {
    let publicClient: any;
    let accountA: any;
    let accountBWallet: any;
    let factory: any;
    let tokenFromA: any;
    let tokenFromB: any;
    let networkName: string;
    let factoryAddress: `0x${string}`;
    let tokenAddress: `0x${string}`;
    let mintId: `0x${string}`;

    const minimumAccountBBalance = 500_000_000_000_000_000n;
    const targetAccountBBalance = 1_000_000_000_000_000_000n;
    const mintAmount = 1_000_000_000_000n;
    const transferAmount = 600_000_000_000n;
    const uniqueSuffix = `${Date.now()}${Math.floor(Math.random() * 1_000_000)
        .toString()
        .padStart(6, "0")}`;
    const testName = `Test ERC20 SPL ${uniqueSuffix}`;
    const testSymbol = `TES${uniqueSuffix.slice(-6)}`;

    before(async function () {
        const { viem, networkName: connectedNetworkName } = await hardhat.network.connect() as unknown as {
            viem: {
                getPublicClient: () => Promise<any>;
                getWalletClients: () => Promise<any[]>;
                getContractAt: (name: string, address: `0x${string}`, config?: unknown) => Promise<any>;
            };
            networkName: string;
        };
        networkName = connectedNetworkName;
        publicClient = await viem.getPublicClient();

        const walletClients = await viem.getWalletClients();
        accountA = walletClients[0];
        if (!accountA?.account) {
            throw new Error("No wallet client available for account A.");
        }

        factoryAddress = resolveFactoryAddress(networkName);
        factory = await viem.getContractAt("ERC20SPLFactory", factoryAddress);

        const factoryCode = await publicClient.getCode({ address: factoryAddress });
        assert.ok(factoryCode && factoryCode !== "0x", `No contract code at ${factoryAddress}`);

        const connection = await hardhat.network.connect();
        const accountBPrivateKey = generatePrivateKey();
        accountBWallet = createWalletClient({
            account: privateKeyToAccount(accountBPrivateKey),
            transport: custom(connection.provider),
        });

        const accountBBalance = await publicClient.getBalance({
            address: accountBWallet.account.address,
        });
        if (accountBBalance < minimumAccountBBalance) {
            const fundingTxHash = await accountA.sendTransaction({
                account: accountA.account,
                to: accountBWallet.account.address,
                value: targetAccountBBalance - accountBBalance,
            });
            await waitForSuccess(publicClient, fundingTxHash, "fund account B");
        }

        // factory.create_user was removed (operator-subsidy cleanup). User registration
        // in the wrapper's `users` mapping now happens implicitly via the first
        // wrapper-mediated mutation (transfer / approve / transferFrom) — for this
        // test, the create_token_mint flow fires it as a side effect when needed.
        [mintId] = await factory.read.get_current_mint([accountA.account.address]);

        const createTokenTxHash = await factory.write.create_token_mint([], {
            account: accountA.account,
        });
        await waitForSuccess(publicClient, createTokenTxHash, "create_token_mint");

        assert.ok(isHex32(mintId), "create_token_mint must return bytes32 mint");
        assert.notEqual(mintId, `0x${"0".repeat(64)}`, "create_token_mint must not return zero mint");

        const initTokenTxHash = await factory.write.init_token_mint([mintId], {
            account: accountA.account,
        });
        await waitForSuccess(publicClient, initTokenTxHash, "init_token_mint");

        const addTokenSimulation = await factory.simulate.add_spl_token_no_metadata([mintId, testName, testSymbol], {
            account: accountA.account,
        });
        tokenAddress = addTokenSimulation.result;

        const addTokenTxHash = await factory.write.add_spl_token_no_metadata(addTokenSimulation.request);
        await waitForSuccess(publicClient, addTokenTxHash, "add_spl_token_no_metadata");

        const symbolHash = keccak256(stringToHex(testSymbol));
        const tokenAddressBySymbol = await factory.read.token_by_symbol_hash([symbolHash]);
        const mintIdBySymbol = await factory.read.mint_by_symbol_hash([symbolHash]);

        assert.notEqual(tokenAddress, zeroAddress, "add_spl_token_no_metadata must return deployed token address");
        assert.equal(
            tokenAddressBySymbol.toLowerCase(),
            tokenAddress.toLowerCase(),
            "token_by_symbol_hash must point to the deployed wrapper",
        );
        assert.equal(
            mintIdBySymbol.toLowerCase(),
            mintId.toLowerCase(),
            "mint_by_symbol_hash must point to the created mint",
        );

        const tokenByMint = await factory.read.token_by_mint([mintId]);
        assert.equal(
            tokenByMint.toLowerCase(),
            tokenAddress.toLowerCase(),
            "token_by_mint must point to the deployed wrapper",
        );

        tokenFromA = await viem.getContractAt("SPL_ERC20", tokenAddress);
        tokenFromB = await viem.getContractAt("SPL_ERC20", tokenAddress, {
            client: {
                public: publicClient,
                wallet: accountBWallet,
            },
        });

        console.log("Testing ERC20SPLFactory at:", factoryAddress);
        console.log("Created SPL_ERC20 token at:", tokenAddress);
        console.log("Created mint:", mintId);
        console.log("Account A:", accountA.account.address);
        console.log("Account B:", accountBWallet.account.address);
    });

    it("creates token with correct name and symbol", async function () {
        const name = await tokenFromA.read.name();
        const symbol = await tokenFromA.read.symbol();

        assert.equal(name, testName);
        assert.equal(symbol, testSymbol);
    });

    it("supports mint (direct precompile), approve, allowance, and transferFrom lifecycle", async function () {
        const ensureAccountATxHash = await tokenFromA.write.ensure_token_account([accountA.account.address], {
            account: accountA.account,
        });
        await waitForSuccess(publicClient, ensureAccountATxHash, "ensure token account for account A");

        const ensureAccountBTxHash = await tokenFromA.write.ensure_token_account([accountBWallet.account.address], {
            account: accountA.account,
        });
        await waitForSuccess(publicClient, ensureAccountBTxHash, "ensure token account for account B");

        // #511: minting moved off the wrapper — the mint authority (account
        // A, per create_token_mint) sends mint_spl directly to 0xff..09.
        const mintToTxHash = await mintSpl(accountA, accountA.account, accountBWallet.account.address, mintAmount, mintId);
        await waitForSuccess(publicClient, mintToTxHash, "mint_spl account B");

        const balanceAAfterMint = await tokenFromA.read.balanceOf([accountA.account.address]);
        const balanceBAfterMint = await tokenFromA.read.balanceOf([accountBWallet.account.address]);

        assert.equal(balanceAAfterMint, 0n, "account A balance must remain zero after minting to account B");
        assert.equal(balanceBAfterMint, mintAmount, "account B balance must equal minted amount");

        const approveTxHash = await tokenFromB.write.approve([accountA.account.address, transferAmount], {
            account: accountBWallet.account,
        });
        await waitForSuccess(publicClient, approveTxHash, "approve account A");

        const allowanceAfterApprove = await tokenFromA.read.allowance([
            accountBWallet.account.address,
            accountA.account.address,
        ]);
        assert.equal(allowanceAfterApprove, transferAmount, "allowance must equal approved amount");

        const transferFromTxHash = await tokenFromA.write.transferFrom([
            accountBWallet.account.address,
            accountA.account.address,
            transferAmount,
        ], {
            account: accountA.account,
        });
        await waitForSuccess(publicClient, transferFromTxHash, "transferFrom account B to account A");

        const balanceAAfterTransfer = await tokenFromA.read.balanceOf([accountA.account.address]);
        const balanceBAfterTransfer = await tokenFromA.read.balanceOf([accountBWallet.account.address]);
        const allowanceAfterTransfer = await tokenFromA.read.allowance([
            accountBWallet.account.address,
            accountA.account.address,
        ]);

        assert.equal(balanceAAfterTransfer, transferAmount, "account A balance must equal transferred amount");
        assert.equal(
            balanceBAfterTransfer,
            mintAmount - transferAmount,
            "account B balance must decrease by transferred amount",
        );
        assert.equal(allowanceAfterTransfer, 0n, "allowance must be fully spent after transferFrom");
    });

    it("does not allow account B to mint without mint authority", async function () {
        // #511: minting is a direct precompile call now, not a wrapper
        // method — the non-authority check moved with it. A direct CALL
        // signs as external_auth(account B); SPL Token's MintToChecked
        // enforces that PDA against the mint's on-chain authority
        // (HelperProgram.pda(account A), set at create_token_mint) and
        // rejects it.
        await expectWriteToFail(
            () => mintSpl(accountBWallet, accountBWallet.account, accountBWallet.account.address, 1n, mintId),
            publicClient,
        );
    });

    it("auto-creates the recipient ATA on first transfer to a fresh address", async function () {
        // Reproduces the 2026-04-26 finding: sending an SPL_ERC20
        // wrapper (wUSDC, wETH, etc.) to an address that has never
        // received this token reverted with "Token account does not
        // exist" because `_transfer` resolved the destination via
        // `get_token_account` (cache-only, reverts on miss). Live
        // symptom: MetaMask greys out the Send button because its
        // `eth_call` simulation hits the same revert. Fix: `_transfer`
        // now calls `ensure_token_account(to)`, which idempotently
        // creates the recipient PDA-ATA on first transfer. Same UX as
        // Phantom and every other Solana wallet.
        const seedAmount = 1_000n;

        const ensureSenderTxHash = await tokenFromA.write.ensure_token_account([
            accountA.account.address,
        ], { account: accountA.account });
        await waitForSuccess(publicClient, ensureSenderTxHash, "ensure sender ATA");
        const mintToSenderTxHash = await mintSpl(accountA, accountA.account, accountA.account.address, seedAmount, mintId);
        await waitForSuccess(publicClient, mintToSenderTxHash, "seed sender balance via mint_spl");

        // Brand-new EVM address. NO `ensure_token_account` call for
        // this address — that's the whole point.
        const freshKey = generatePrivateKey();
        const freshAddress = privateKeyToAccount(freshKey).address;

        // Pre-fix this reverts with "Token account does not exist".
        // Post-fix the wrapper creates the ATA inside the transfer.
        const transferTxHash = await tokenFromA.write.transfer([
            freshAddress,
            seedAmount,
        ], { account: accountA.account });
        await waitForSuccess(publicClient, transferTxHash, "transfer to fresh recipient");

        const balanceFreshAfter = await tokenFromA.read.balanceOf([freshAddress]);
        assert.equal(
            balanceFreshAfter,
            seedAmount,
            "fresh recipient must show transferred balance after auto-ATA-create",
        );
    });

    // #511 behavior change: mint_to (wrapper-mediated, auto-created the
    // recipient's ATA via ensure_token_account before the SPL CPI) is
    // deleted. Minting now goes straight to HelperProgram — it has no
    // wrapper method to hook an auto-create into, so a mint to a
    // never-touched address's ATA fails until something (the wrapper's
    // still-live ensure_token_account, a prior transfer, an inbound
    // bridge) creates it first. This replaces the old "mint auto-creates"
    // regression test with its mirror image: mint alone does NOT create
    // the ATA any more; ensure_token_account still does.
    it("mint_spl to a fresh address's un-created ATA fails; ensure_token_account first fixes it", async function () {
        const freshKey = generatePrivateKey();
        const freshAddress = privateKeyToAccount(freshKey).address;
        const mintAmt = 500n;

        await expectWriteToFail(
            () => mintSpl(accountA, accountA.account, freshAddress, mintAmt, mintId),
            publicClient,
        );

        const ensureFreshTxHash = await tokenFromA.write.ensure_token_account([freshAddress], {
            account: accountA.account,
        });
        await waitForSuccess(publicClient, ensureFreshTxHash, "ensure fresh recipient ATA");

        const mintTxHash = await mintSpl(accountA, accountA.account, freshAddress, mintAmt, mintId);
        await waitForSuccess(publicClient, mintTxHash, "mint_spl to fresh recipient post-ensure");

        const balanceFresh = await tokenFromA.read.balanceOf([freshAddress]);
        assert.equal(
            balanceFresh,
            mintAmt,
            "fresh recipient balance must equal minted amount once its ATA exists",
        );
    });

    it("does not allow account A to transfer from account B without allowance", async function () {
        const resetApprovalTxHash = await tokenFromB.write.approve([accountA.account.address, 0n], {
            account: accountBWallet.account,
        });
        await waitForSuccess(publicClient, resetApprovalTxHash, "reset approval");

        await expectWriteToFail(
            () =>
                tokenFromA.write.transferFrom([
                    accountBWallet.account.address,
                    accountA.account.address,
                    1n,
                ], {
                    account: accountA.account,
                }),
            publicClient,
        );
    });
});
