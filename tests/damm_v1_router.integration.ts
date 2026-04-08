import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { getAddress, isAddress, zeroAddress } from "viem";
import { readDeployments } from "../scripts/lib/deployments.js";

function requireOneOfEnv(...names: string[]): string {
    for (const name of names) {
        const value = process.env[name];
        if (value) {
            return value;
        }
    }

    throw new Error(`Missing required environment variable. Provide one of: ${names.join(", ")}`);
}

function resolveDeploymentAddress(
    networkName: string,
    key: "MeteoraDAMMv1Factory" | "MeteoraDAMMv1Router" | "ERC20SPLFactory",
): `0x${string}` {
    const deployments = readDeployments(networkName);
    const address = deployments[key]?.address;

    if (!address) {
        throw new Error(`${key} is not deployed for ${networkName}. Run the deployment script first.`);
    }

    if (!isAddress(address)) {
        throw new Error(`Invalid ${key} address in deployments/${networkName}.json: ${address}`);
    }

    return getAddress(address);
}

function parseBytes32(value: string, name: string): `0x${string}` {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`Invalid ${name}: expected bytes32 hex value, got ${value}`);
    }

    return value as `0x${string}`;
}

function parseUint(value: string, name: string): bigint {
    const parsed = BigInt(value);
    if (parsed < 0n) {
        throw new Error(`${name} must be non-negative, got ${value}`);
    }

    return parsed;
}

function selectSwapDirection(value: string): 0 | 1 {
    const normalized = value.trim().toLowerCase();
    if (normalized === "0" || normalized === "a" || normalized === "tokena") {
        return 0;
    }
    if (normalized === "1" || normalized === "b" || normalized === "tokenb") {
        return 1;
    }

    throw new Error(`Invalid swap direction ${value}. Use 0/tokenA or 1/tokenB.`);
}

async function waitForSuccess(
    publicClient: {
        waitForTransactionReceipt: (
            args: { hash: `0x${string}` },
        ) => Promise<{ status: string; blockNumber: bigint }>;
    },
    txHash: `0x${string}`,
    label: string,
): Promise<{ status: string; blockNumber: bigint }> {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    assert.equal(receipt.status, "success", `${label} transaction failed`);
    return receipt;
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

describe("MeteoraDAMMv1Router integration", { concurrency: false }, function () {
    let viem: any;
    let publicClient: any;
    let deployer: any;
    let factory: any;
    let routerFromUser: any;
    let erc20SplFactory: any;
    let erc20FactoryFromUser: any;
    let users: any;
    let networkName: string;

    let factoryAddress: `0x${string}`;
    let routerAddress: `0x${string}`;
    let erc20SplFactoryAddress: `0x${string}`;
    let poolPubkey: `0x${string}`;
    let swapDirection: 0 | 1;
    let amountIn: bigint;
    let minAmountOut: bigint;

    let swapUser: any;

    let rawPoolAddress: `0x${string}`;
    let wrappedPoolAddress: `0x${string}`;
    let tokenAAddress: `0x${string}`;
    let tokenBAddress: `0x${string}`;
    let tokenAFromUser: any;
    let tokenBFromUser: any;

    before(async function () {
        const { viem: connectedViem, networkName: connectedNetworkName } = await hardhat.network.connect() as unknown as {
            viem: {
                getPublicClient: () => Promise<any>;
                getWalletClients: () => Promise<any[]>;
                getContractAt: (name: string, address: `0x${string}`, config?: unknown) => Promise<any>;
            };
            networkName: string;
        };

        viem = connectedViem;
        networkName = connectedNetworkName;
        publicClient = await viem.getPublicClient();

        const walletClients = await viem.getWalletClients();
        deployer = walletClients[0];
        if (!deployer?.account) {
            throw new Error("No wallet client available.");
        }

        swapUser = deployer;
        factoryAddress = resolveDeploymentAddress(networkName, "MeteoraDAMMv1Factory");
        routerAddress = resolveDeploymentAddress(networkName, "MeteoraDAMMv1Router");
        erc20SplFactoryAddress = resolveDeploymentAddress(networkName, "ERC20SPLFactory");

        poolPubkey = parseBytes32(requireOneOfEnv("ROUTER_POOL_PUBKEY", "POOL_PUBKEY"), "ROUTER_POOL_PUBKEY");
        swapDirection = selectSwapDirection(requireOneOfEnv("ROUTER_SWAP_IN_TOKEN", "SWAP_IN_TOKEN"));
        amountIn = parseUint(requireOneOfEnv("ROUTER_SWAP_AMOUNT_IN", "SWAP_IN_AMOUNT"), "ROUTER_SWAP_AMOUNT_IN");
        minAmountOut = parseUint(requireOneOfEnv("ROUTER_SWAP_MIN_OUT", "SWAP_MIN_OUT"), "ROUTER_SWAP_MIN_OUT");

        factory = await viem.getContractAt("MeteoraDAMMv1Factory", factoryAddress);
        erc20SplFactory = await viem.getContractAt("ERC20SPLFactory", erc20SplFactoryAddress);
        erc20FactoryFromUser = await viem.getContractAt("ERC20SPLFactory", erc20SplFactoryAddress, {
            client: {
                public: publicClient,
                wallet: swapUser,
            },
        });
        routerFromUser = await viem.getContractAt("MeteoraDAMMv1Router", routerAddress, {
            client: {
                public: publicClient,
                wallet: swapUser,
            },
        });

        const factoryCode = await publicClient.getCode({ address: factoryAddress });
        const routerCode = await publicClient.getCode({ address: routerAddress });
        const erc20FactoryCode = await publicClient.getCode({ address: erc20SplFactoryAddress });
        assert.ok(factoryCode && factoryCode !== "0x", `No contract code at ${factoryAddress}`);
        assert.ok(routerCode && routerCode !== "0x", `No contract code at ${routerAddress}`);
        assert.ok(erc20FactoryCode && erc20FactoryCode !== "0x", `No contract code at ${erc20SplFactoryAddress}`);

        const usersAddress = await erc20SplFactory.read.users();
        users = await viem.getContractAt("ERC20Users", usersAddress);

        try {
            await users.read.get_user([swapUser.account.address]);
        } catch {
            const createUserTxHash = await erc20FactoryFromUser.write.create_user([], {
                account: swapUser.account,
            });
            await waitForSuccess(publicClient, createUserTxHash, "create_user for swap user");
        }

        console.log("Testing MeteoraDAMMv1Factory at:", factoryAddress);
        console.log("Testing MeteoraDAMMv1Router at:", routerAddress);
        console.log("Using ERC20SPLFactory at:", erc20SplFactoryAddress);
        console.log("Pool pubkey:", poolPubkey);
        console.log("Swap user:", swapUser.account.address);
    });

    it("adds a new pool from env pubkey using the deployed factory", async function () {
        const poolsLengthBefore = await factory.read.allPoolsLength();
        const simulatedAddPool = await factory.simulate.addPool([poolPubkey], {
            account: deployer.account,
        });

        rawPoolAddress = getAddress(simulatedAddPool.result);

        const txHash = await factory.write.addPool(simulatedAddPool.request);
        await waitForSuccess(publicClient, txHash, "factory.addPool");

        const poolsLengthAfter = await factory.read.allPoolsLength();
        assert.equal(poolsLengthAfter, poolsLengthBefore + 1n, "allPoolsLength must increment by 1");

        wrappedPoolAddress = await factory.read.allPools([poolsLengthAfter - 1n]);
        assert.notEqual(wrappedPoolAddress, zeroAddress, "wrapped pool address must not be zero");

        const rawPool = await viem.getContractAt("DAMMv1Pool", rawPoolAddress);

        const tokenAMint = await rawPool.read.token_a_mint();
        const tokenBMint = await rawPool.read.token_b_mint();

        tokenAAddress = getAddress(await erc20SplFactory.read.token_by_mint([tokenAMint]));
        tokenBAddress = getAddress(await erc20SplFactory.read.token_by_mint([tokenBMint]));

        assert.notEqual(tokenAAddress, zeroAddress, "token A wrapper must exist");
        assert.notEqual(tokenBAddress, zeroAddress, "token B wrapper must exist");

        const poolForTokenOrder = await factory.read.getPool([tokenAAddress, tokenBAddress]);
        const poolForReverseOrder = await factory.read.getPool([tokenBAddress, tokenAAddress]);

        assert.equal(
            poolForTokenOrder.toLowerCase(),
            wrappedPoolAddress.toLowerCase(),
            "getPool(tokenA, tokenB) must point to the added pool",
        );
        assert.equal(
            poolForReverseOrder.toLowerCase(),
            wrappedPoolAddress.toLowerCase(),
            "getPool(tokenB, tokenA) must point to the added pool",
        );

        tokenAFromUser = await viem.getContractAt("SPL_ERC20", tokenAAddress, {
            client: {
                public: publicClient,
                wallet: swapUser,
            },
        });
        tokenBFromUser = await viem.getContractAt("SPL_ERC20", tokenBAddress, {
            client: {
                public: publicClient,
                wallet: swapUser,
            },
        });

        const ensureTokenATxHash = await tokenAFromUser.write.ensure_token_account([swapUser.account.address], {
            account: swapUser.account,
        });
        await waitForSuccess(publicClient, ensureTokenATxHash, "ensure token A account");

        const ensureTokenBTxHash = await tokenBFromUser.write.ensure_token_account([swapUser.account.address], {
            account: swapUser.account,
        });
        await waitForSuccess(publicClient, ensureTokenBTxHash, "ensure token B account");
    });

    it("executes router swap path for a user with initialized accounts", async function () {
        assert.ok(tokenAFromUser, "tokenA contract is not initialized; add pool test must run first");
        assert.ok(tokenBFromUser, "tokenB contract is not initialized; add pool test must run first");

        const inputToken = swapDirection === 0 ? tokenAFromUser : tokenBFromUser;
        const outputToken = swapDirection === 0 ? tokenBFromUser : tokenAFromUser;
        const inputTokenAddress = swapDirection === 0 ? tokenAAddress : tokenBAddress;
        const outputTokenAddress = swapDirection === 0 ? tokenBAddress : tokenAAddress;

        const inputBalanceBefore = await inputToken.read.balanceOf([swapUser.account.address]);
        const outputBalanceBefore = await outputToken.read.balanceOf([swapUser.account.address]);

        assert.ok(
            inputBalanceBefore >= amountIn,
            `Swap user ${swapUser.account.address} must already hold at least ${amountIn} of ${inputTokenAddress}`,
        );

        await expectWriteToFail(
            () =>
                routerFromUser.write.swapExactTokensForTokens(
                    [inputTokenAddress, outputTokenAddress, amountIn, minAmountOut],
                    {
                        account: swapUser.account,
                    },
                ),
            publicClient,
        );

        const inputBalanceAfter = await inputToken.read.balanceOf([swapUser.account.address]);
        const outputBalanceAfter = await outputToken.read.balanceOf([swapUser.account.address]);

        assert.equal(
            inputBalanceAfter,
            inputBalanceBefore,
            "input token balance must remain unchanged after the failed router swap",
        );
        assert.equal(
            outputBalanceAfter,
            outputBalanceBefore,
            "output token balance must remain unchanged after the failed router swap",
        );
    });
});
