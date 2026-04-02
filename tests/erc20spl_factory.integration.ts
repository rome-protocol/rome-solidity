import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import {
    createWalletClient,
    getAddress,
    http,
    isAddress,
    keccak256,
    stringToHex,
    zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readDeployments } from "../scripts/lib/deployments.js";

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

function resolveRpcUrl(networkName: string): string {
    if (process.env.TEST_RPC_URL) {
        return process.env.TEST_RPC_URL;
    }

    switch (networkName) {
        case "monti_spl":
            return "https://montispl-i.devnet.romeprotocol.xyz/";
        case "local":
            return "http://localhost:9090";
        default:
            throw new Error(
                `Unknown RPC URL for network ${networkName}. Set TEST_RPC_URL to run this test.`,
            );
    }
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
    const testName = `Test ERC20 SPL ${Date.now()}`;
    const testSymbol = `TES${Date.now().toString().slice(-6)}`;

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

        const accountBPrivateKey = generatePrivateKey();
        accountBWallet = createWalletClient({
            account: privateKeyToAccount(accountBPrivateKey),
            transport: http(resolveRpcUrl(networkName)),
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

        const nonceBefore = await factory.read.creator_nonce([accountA.account.address]);

        const createTokenTxHash = await factory.write.create_token_account([], {
            account: accountA.account,
        });
        await waitForSuccess(publicClient, createTokenTxHash, "create_token_account");

        const nonceAfterCreate = await factory.read.creator_nonce([accountA.account.address]);
        assert.equal(
            nonceAfterCreate,
            nonceBefore,
            "create_token_account must not increment creator_nonce before init",
        );

        const initTokenTxHash = await factory.write.init_token_account([testName, testSymbol], {
            account: accountA.account,
        });
        await waitForSuccess(publicClient, initTokenTxHash, "init_token_account");

        const nonceAfterInit = await factory.read.creator_nonce([accountA.account.address]);
        assert.equal(
            nonceAfterInit,
            nonceBefore + 1n,
            "init_token_account must increment creator_nonce",
        );

        const symbolHash = keccak256(stringToHex(testSymbol));
        tokenAddress = await factory.read.token_by_symbol_hash([symbolHash]);
        mintId = await factory.read.mint_by_symbol_hash([symbolHash]);

        assert.notEqual(tokenAddress, zeroAddress, "token_by_symbol_hash must return deployed token address");
        assert.ok(isHex32(mintId), "mint_by_symbol_hash must return bytes32 mint");
        assert.notEqual(mintId, `0x${"0".repeat(64)}`, "mint_by_symbol_hash must not be zero");

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

    it("supports mint_to, approve, allowance, and transferFrom lifecycle", async function () {
        const ensureAccountATxHash = await tokenFromA.write.ensure_token_account([accountA.account.address], {
            account: accountA.account,
        });
        await waitForSuccess(publicClient, ensureAccountATxHash, "ensure token account for account A");

        const mintToTxHash = await tokenFromA.write.mint_to([accountBWallet.account.address, mintAmount], {
            account: accountA.account,
        });
        await waitForSuccess(publicClient, mintToTxHash, "mint_to account B");

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
        await expectWriteToFail(
            () =>
                tokenFromB.write.mint_to([accountBWallet.account.address, 1n], {
                    account: accountBWallet.account,
                }),
            publicClient,
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
