import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { getAddress, isAddress, zeroAddress } from "viem";
import { readDeployments } from "../scripts/lib/deployments.js";

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

function isHex32(value: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isZeroBytes32(value: string): boolean {
    return /^0x0{64}$/i.test(value);
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

async function ensureUser(factoryFromUser: any, users: any, publicClient: any, user: any): Promise<void> {
    try {
        await users.read.get_user([user.account.address]);
    } catch {
        const createUserTxHash = await factoryFromUser.write.create_user([], {
            account: user.account,
        });
        await waitForSuccess(publicClient, createUserTxHash, "create_user");
    }
}

async function ensureTokenAccount(token: any, publicClient: any, owner: any, label: string): Promise<void> {
    const txHash = await token.write.ensure_token_account([owner.account.address], {
        account: owner.account,
    });
    await waitForSuccess(publicClient, txHash, label);
}

async function assertSolanaAccountExists(
    cpiProgram: any,
    pubkey: `0x${string}` | string,
    label: string,
): Promise<void> {
    const info = await cpiProgram.read.account_info([pubkey]);
    assert.ok(info[0] > 0n, `${label} must exist on Solana`);
}

async function assertSolanaProgramExists(
    cpiProgram: any,
    pubkey: `0x${string}` | string,
    label: string,
): Promise<void> {
    const info = await cpiProgram.read.account_info([pubkey]);
    assert.ok(info[0] > 0n, `${label} program account must exist on Solana`);
    assert.equal(info[4], true, `${label} program account must be executable`);
}

async function findExistingConfig(factory: any, cpiProgram: any, maxIndex = 16): Promise<`0x${string}`> {
    for (let index = 0n; index < BigInt(maxIndex); index++) {
        const config = await factory.read.deriveConfigKey([index]);
        const info = await cpiProgram.read.account_info([config]);
        if (info[0] > 0n) {
            return config;
        }
    }

    throw new Error(`No existing DAMM config found in first ${maxIndex} config PDAs.`);
}

async function createSplToken(args: {
    factory: any;
    publicClient: any;
    viem: any;
    owner: any;
    name: string;
    symbol: string;
}): Promise<{
    mintId: `0x${string}`;
    tokenAddress: `0x${string}`;
    token: any;
}> {
    const { factory, publicClient, viem, owner, name, symbol } = args;

    const [mintId] = await factory.read.get_current_mint([owner.account.address]);

    const createTokenTxHash = await factory.write.create_token_mint([], {
        account: owner.account,
    });
    await waitForSuccess(publicClient, createTokenTxHash, `create_token_mint ${symbol}`);

    const initTokenTxHash = await factory.write.init_token_mint([mintId], {
        account: owner.account,
    });
    await waitForSuccess(publicClient, initTokenTxHash, `init_token_mint ${symbol}`);

    const addTokenSimulation = await factory.simulate.add_spl_token_no_metadata(
        [mintId, name, symbol],
        {
            account: owner.account,
        },
    );
    const tokenAddress = addTokenSimulation.result;

    const addTokenTxHash = await factory.write.add_spl_token_no_metadata(addTokenSimulation.request);
    await waitForSuccess(publicClient, addTokenTxHash, `add_spl_token_no_metadata ${symbol}`);

    const token = await viem.getContractAt("SPL_ERC20", tokenAddress, {
        client: {
            public: publicClient,
            wallet: owner,
        },
    });

    return { mintId, tokenAddress, token };
}

describe("MeteoraDAMMv1Router integration", { concurrency: false }, function () {
    let viem: any;
    let publicClient: any;
    let deployer: any;
    let factory: any;
    let factoryFromUser: any;
    let routerFromUser: any;
    let erc20SplFactory: any;
    let erc20FactoryFromUser: any;
    let users: any;
    let cpiProgram: any;
    let networkName: string;

    let factoryAddress: `0x${string}`;
    let routerAddress: `0x${string}`;
    let erc20SplFactoryAddress: `0x${string}`;

    let tokenAMint: `0x${string}`;
    let tokenBMint: `0x${string}`;
    let tokenAAddress: `0x${string}`;
    let tokenBAddress: `0x${string}`;
    let tokenAFromUser: any;
    let tokenBFromUser: any;
    let payer: `0x${string}`;
    let userTokenAccountA: `0x${string}`;
    let userTokenAccountB: `0x${string}`;
    let progDynamicVault: `0x${string}`;
    let progDynamicAmm: `0x${string}`;
    let previewVaultA: any;
    let previewVaultB: any;
    let poolConfig: `0x${string}`;

    let poolPubkey: `0x${string}`;
    let wrappedPoolAddress: `0x${string}`;

    const mintAmount = 2_000_000_000_000n;
    const poolTokenAAmount = 500_000_000_000n;
    const poolTokenBAmount = 500_000_000_000n;
    const swapAmountIn = 100_000_000n;
    const minAmountOut = 0n;

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

        factoryAddress = resolveDeploymentAddress(networkName, "MeteoraDAMMv1Factory");
        routerAddress = resolveDeploymentAddress(networkName, "MeteoraDAMMv1Router");
        erc20SplFactoryAddress = resolveDeploymentAddress(networkName, "ERC20SPLFactory");

        factory = await viem.getContractAt("MeteoraDAMMv1Factory", factoryAddress);
        factoryFromUser = await viem.getContractAt("MeteoraDAMMv1Factory", factoryAddress, {
            client: {
                public: publicClient,
                wallet: deployer,
            },
        });
        erc20SplFactory = await viem.getContractAt("ERC20SPLFactory", erc20SplFactoryAddress);
        erc20FactoryFromUser = await viem.getContractAt("ERC20SPLFactory", erc20SplFactoryAddress, {
            client: {
                public: publicClient,
                wallet: deployer,
            },
        });
        routerFromUser = await viem.getContractAt("MeteoraDAMMv1Router", routerAddress, {
            client: {
                public: publicClient,
                wallet: deployer,
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
        await ensureUser(erc20FactoryFromUser, users, publicClient, deployer);
        payer = await users.read.get_user([deployer.account.address]);

        const configuredTokenFactoryAddress = getAddress(await factory.read.token_factory());
        assert.equal(
            configuredTokenFactoryAddress.toLowerCase(),
            erc20SplFactoryAddress.toLowerCase(),
            "MeteoraDAMMv1Factory must be configured with the deployed ERC20SPLFactory",
        );

        assert.ok(isHex32(payer), "payer must be bytes32");
        assert.notEqual(payer, `0x${"0".repeat(64)}`, "payer must not be zero");

        const cpiProgramAddress = await factory.read.cpi_program();
        cpiProgram = await viem.getContractAt("ICrossProgramInvocation", cpiProgramAddress);
        progDynamicVault = await factory.read.prog_dynamic_vault();
        progDynamicAmm = await factory.read.prog_dynamic_amm();

        assert.ok(isHex32(progDynamicVault), "prog_dynamic_vault must be bytes32");
        assert.ok(isHex32(progDynamicAmm), "prog_dynamic_amm must be bytes32");
        assert.ok(!isZeroBytes32(progDynamicVault), "prog_dynamic_vault must not be zero");
        assert.ok(!isZeroBytes32(progDynamicAmm), "prog_dynamic_amm must not be zero");

        await assertSolanaAccountExists(cpiProgram, payer, "payer");
        await assertSolanaProgramExists(cpiProgram, progDynamicVault, "prog_dynamic_vault");
        await assertSolanaProgramExists(cpiProgram, progDynamicAmm, "prog_dynamic_amm");

        poolConfig = await findExistingConfig(factory, cpiProgram);
        await assertSolanaAccountExists(cpiProgram, poolConfig, "damm config");

        const uniqueSuffix = `${Date.now()}${Math.floor(Math.random() * 1_000_000)
            .toString()
            .padStart(6, "0")}`;

        const tokenA = await createSplToken({
            factory: erc20FactoryFromUser,
            publicClient,
            viem,
            owner: deployer,
            name: `Router Token A ${uniqueSuffix}`,
            symbol: `RTA${uniqueSuffix.slice(-5)}`,
        });
        const tokenB = await createSplToken({
            factory: erc20FactoryFromUser,
            publicClient,
            viem,
            owner: deployer,
            name: `Router Token B ${uniqueSuffix}`,
            symbol: `RTB${uniqueSuffix.slice(-5)}`,
        });

        tokenAMint = tokenA.mintId;
        tokenBMint = tokenB.mintId;
        tokenAAddress = tokenA.tokenAddress;
        tokenBAddress = tokenB.tokenAddress;
        tokenAFromUser = tokenA.token;
        tokenBFromUser = tokenB.token;

        await assertSolanaAccountExists(cpiProgram, tokenAMint, "token A mint");
        await assertSolanaAccountExists(cpiProgram, tokenBMint, "token B mint");

        await ensureTokenAccount(tokenAFromUser, publicClient, deployer, "ensure token A account");
        await ensureTokenAccount(tokenBFromUser, publicClient, deployer, "ensure token B account");

        userTokenAccountA = await tokenAFromUser.read.get_token_account([deployer.account.address]);
        userTokenAccountB = await tokenBFromUser.read.get_token_account([deployer.account.address]);

        await assertSolanaAccountExists(cpiProgram, userTokenAccountA, "user token A account");
        await assertSolanaAccountExists(cpiProgram, userTokenAccountB, "user token B account");

        previewVaultA = await factory.read.previewInitializeVault([tokenAMint, deployer.account.address]);
        previewVaultB = await factory.read.previewInitializeVault([tokenBMint, deployer.account.address]);
        assert.equal(previewVaultA[1].payer, payer, "vault A payer must match payer");
        assert.equal(previewVaultB[1].payer, payer, "vault B payer must match payer");
        assert.equal(previewVaultA[1].token_mint, tokenAMint, "vault A token mint must match");
        assert.equal(previewVaultB[1].token_mint, tokenBMint, "vault B token mint must match");

        const mintTokenATxHash = await tokenAFromUser.write.mint_to([deployer.account.address, mintAmount], {
            account: deployer.account,
        });
        await waitForSuccess(publicClient, mintTokenATxHash, "mint token A");

        const mintTokenBTxHash = await tokenBFromUser.write.mint_to([deployer.account.address, mintAmount], {
            account: deployer.account,
        });
        await waitForSuccess(publicClient, mintTokenBTxHash, "mint token B");

        const initVaultATxHash = await factoryFromUser.write.initializeVaultIfMissing([tokenAMint], {
            account: deployer.account,
        });
        await waitForSuccess(publicClient, initVaultATxHash, "initialize vault A");

        const initVaultBTxHash = await factoryFromUser.write.initializeVaultIfMissing([tokenBMint], {
            account: deployer.account,
        });
        await waitForSuccess(publicClient, initVaultBTxHash, "initialize vault B");

        await assertSolanaAccountExists(cpiProgram, previewVaultA[1].vault, "vault A");
        await assertSolanaAccountExists(cpiProgram, previewVaultA[1].token_vault, "vault A token vault");
        await assertSolanaAccountExists(cpiProgram, previewVaultA[1].lp_mint, "vault A lp mint");
        await assertSolanaAccountExists(cpiProgram, previewVaultB[1].vault, "vault B");
        await assertSolanaAccountExists(cpiProgram, previewVaultB[1].token_vault, "vault B token vault");
        await assertSolanaAccountExists(cpiProgram, previewVaultB[1].lp_mint, "vault B lp mint");

        poolPubkey = await factory.read.derivePermissionlessConstantProductPoolWithConfigKey([
            tokenAMint,
            tokenBMint,
            poolConfig,
        ]);

        const createPoolTxHash = await factoryFromUser.write.createPermissionlessConstantProductPoolWithConfig2(
            [
                tokenAMint,
                tokenBMint,
                poolTokenAAmount,
                poolTokenBAmount,
                poolConfig,
            ],
            {
                account: deployer.account,
            },
        );
        await waitForSuccess(publicClient, createPoolTxHash, "createPermissionlessConstantProductPoolWithConfig2");

        await assertSolanaAccountExists(cpiProgram, poolPubkey, "damm v1 pool");
        const poolState = await factory.read.derivePermissionlessConstantProductPoolWithConfigKey([
            tokenAMint,
            tokenBMint,
            poolConfig,
        ]);
        assert.equal(poolState.toLowerCase(), poolPubkey.toLowerCase(), "derived pool key must stay stable");

        const addPoolTxHash = await factoryFromUser.write.addPool([poolPubkey], {
            account: deployer.account,
        });
        await waitForSuccess(publicClient, addPoolTxHash, "addPool");

        wrappedPoolAddress = await factory.read.getPool([tokenAAddress, tokenBAddress]);
        assert.notEqual(wrappedPoolAddress, zeroAddress, "wrapped pool must be registered");
    });

    it("creates two SPL_ERC20 tokens and registers a wrapped pool", async function () {
        assert.ok(isHex32(tokenAMint), "token A mint must be bytes32");
        assert.ok(isHex32(tokenBMint), "token B mint must be bytes32");
        assert.notEqual(tokenAAddress, zeroAddress, "token A wrapper must exist");
        assert.notEqual(tokenBAddress, zeroAddress, "token B wrapper must exist");
        assert.ok(isHex32(poolPubkey), "pool pubkey must be bytes32");
        assert.notEqual(wrappedPoolAddress, zeroAddress, "wrapped pool address must not be zero");

        const poolForTokenOrder = await factory.read.getPool([tokenAAddress, tokenBAddress]);
        const poolForReverseOrder = await factory.read.getPool([tokenBAddress, tokenAAddress]);

        assert.equal(
            poolForTokenOrder.toLowerCase(),
            wrappedPoolAddress.toLowerCase(),
            "getPool(tokenA, tokenB) must point to the created pool",
        );
        assert.equal(
            poolForReverseOrder.toLowerCase(),
            wrappedPoolAddress.toLowerCase(),
            "getPool(tokenB, tokenA) must point to the created pool",
        );

        const tokenAccountA = await tokenAFromUser.read.get_token_account([deployer.account.address]);
        const tokenAccountB = await tokenBFromUser.read.get_token_account([deployer.account.address]);
        assert.ok(isHex32(tokenAccountA), "user token A account must exist");
        assert.ok(isHex32(tokenAccountB), "user token B account must exist");
        assert.equal(tokenAccountA.toLowerCase(), userTokenAccountA.toLowerCase(), "cached token A account must match");
        assert.equal(tokenAccountB.toLowerCase(), userTokenAccountB.toLowerCase(), "cached token B account must match");
    });

    it("executes swapExactTokensForTokens on the router", async function () {
        const inputBalanceBefore = await tokenAFromUser.read.balanceOf([deployer.account.address]);
        const outputBalanceBefore = await tokenBFromUser.read.balanceOf([deployer.account.address]);

        assert.ok(
            inputBalanceBefore >= swapAmountIn,
            `swap user must hold at least ${swapAmountIn} token A before swap`,
        );

        const swapTxHash = await routerFromUser.write.swapExactTokensForTokens(
            [tokenAAddress, tokenBAddress, swapAmountIn, minAmountOut],
            {
                account: deployer.account,
            },
        );
        await waitForSuccess(publicClient, swapTxHash, "router swap");

        const inputBalanceAfter = await tokenAFromUser.read.balanceOf([deployer.account.address]);
        const outputBalanceAfter = await tokenBFromUser.read.balanceOf([deployer.account.address]);

        assert.equal(
            inputBalanceAfter,
            inputBalanceBefore - swapAmountIn,
            "input token balance must decrease by the swap amount",
        );
        assert.ok(
            outputBalanceAfter > outputBalanceBefore,
            "output token balance must increase after the router swap",
        );
    });
});
