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

function readU64LE(data: `0x${string}` | string, offset: number): bigint {
    const hex = data.startsWith("0x") ? data.slice(2) : data;
    const start = offset * 2;
    const end = start + 16;
    const value = hex.slice(start, end);

    let result = 0n;
    for (let i = 0; i < 8; i++) {
        const byteHex = value.slice(i * 2, i * 2 + 2) || "00";
        result |= BigInt(parseInt(byteHex, 16)) << (8n * BigInt(i));
    }

    return result;
}

async function readSplTokenAmount(
    cpiProgram: any,
    pubkey: `0x${string}` | string,
): Promise<bigint> {
    const info = await cpiProgram.read.account_info([pubkey]);
    if (info[0] === 0n) {
        return 0n;
    }

    return readU64LE(info[5], 64);
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
    let wrappedPool: any;
    let internalPool: any;
    let userPoolLp: `0x${string}`;
    let addedLiquidityLpAmount = 0n;

    const mintAmount = 2_000_000_000_000n;
    const poolTokenAAmount = 500_000_000_000n;
    const poolTokenBAmount = 500_000_000_000n;
    const swapAmountIn = 100_000_000n;
    const minAmountOut = 0n;
    const addLiquidityTokenAAmount = 100_000_000n;
    const addLiquidityTokenBAmount = 100_000_000n;

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

        poolConfig = "0x644ca100bdd0fb4a40a19bd736434cec22a01b0f380626464ad69a115df8ef80";
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

        console.log("Token A Mint: ", tokenAMint);
        console.log("Token B Mint: ", tokenBMint);

        const preparedPoolAccounts = await factory.read.preparePermissionlessConstantProductPoolWithConfig2([
            tokenAMint,
            tokenBMint,
            poolConfig,
        ]);
        assert.equal(
            preparedPoolAccounts.pool.toLowerCase(),
            poolPubkey.toLowerCase(),
            "prepared pool PDA must match derived pool key",
        );

        const createPoolTxHash = await factoryFromUser.write.createPermissionlessConstantProductPoolWithConfig2(
            [
                poolTokenAAmount,
                poolTokenBAmount,
                preparedPoolAccounts,
            ],
            {
                account: deployer.account,
            },
        );
        await waitForSuccess(publicClient, createPoolTxHash, "createPermissionlessConstantProductPoolWithConfig2");

        console.log("Pool created ", poolPubkey);
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

        wrappedPool = await viem.getContractAt("ERC20DAMMv1Pool", wrappedPoolAddress, {
            client: {
                public: publicClient,
                wallet: deployer,
            },
        });
        internalPool = await viem.getContractAt("DAMMv1Pool", await wrappedPool.read.internal_pool());

        const liquidityAccounts = await internalPool.read.make_balance_liquidity_accounts_from_pool([payer]);
        userPoolLp = liquidityAccounts.user_pool_lp;
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

    it("executes addLiquidity on the router", async function () {
        const ensurePoolLpTokenAccountTxHash = await routerFromUser.write.ensurePoolLpTokenAccount(
            [tokenAAddress, tokenBAddress],
            {
                account: deployer.account,
            },
        );
        await waitForSuccess(publicClient, ensurePoolLpTokenAccountTxHash, "router ensurePoolLpTokenAccount");
        await assertSolanaAccountExists(cpiProgram, userPoolLp, "user pool LP account");

        const tokenABalanceBefore = await tokenAFromUser.read.balanceOf([deployer.account.address]);
        const tokenBBalanceBefore = await tokenBFromUser.read.balanceOf([deployer.account.address]);
        const lpBalanceBefore = await readSplTokenAmount(cpiProgram, userPoolLp);

        const preparedAddLiquidity = await routerFromUser.read.prepareAddLiquidity([
            tokenAAddress,
            tokenBAddress,
            deployer.account.address,
            addLiquidityTokenAAmount,
            addLiquidityTokenBAmount,
            0n,
        ]);
        const quotedPoolTokenAmount = preparedAddLiquidity[0];
        const liquidityAccounts = preparedAddLiquidity[1];

        assert.ok(quotedPoolTokenAmount > 0n, "quoted pool token amount must be positive");
        assert.equal(
            liquidityAccounts.user_pool_lp.toLowerCase(),
            userPoolLp.toLowerCase(),
            "prepared user_pool_lp must match derived LP ATA",
        );

        const addLiquidityTxHash = await routerFromUser.write.addLiquidity(
            [
                tokenAAddress,
                tokenBAddress,
                quotedPoolTokenAmount,
                addLiquidityTokenAAmount,
                addLiquidityTokenBAmount,
                liquidityAccounts,
            ],
            {
                account: deployer.account,
            },
        );
        await waitForSuccess(publicClient, addLiquidityTxHash, "router addLiquidity");

        const tokenABalanceAfter = await tokenAFromUser.read.balanceOf([deployer.account.address]);
        const tokenBBalanceAfter = await tokenBFromUser.read.balanceOf([deployer.account.address]);
        const lpBalanceAfter = await readSplTokenAmount(cpiProgram, userPoolLp);

        assert.ok(
            tokenABalanceAfter < tokenABalanceBefore,
            "token A balance must decrease after addLiquidity",
        );
        assert.ok(
            tokenBBalanceAfter < tokenBBalanceBefore,
            "token B balance must decrease after addLiquidity",
        );
        assert.ok(
            lpBalanceAfter > lpBalanceBefore,
            "LP balance must increase after addLiquidity",
        );

        addedLiquidityLpAmount = lpBalanceAfter - lpBalanceBefore;
        assert.ok(addedLiquidityLpAmount > 0n, "minted LP amount must be positive");
    });

    it("executes removeLiquidity on the router", async function () {
        assert.ok(addedLiquidityLpAmount > 0n, "removeLiquidity test requires prior addLiquidity");

        const tokenABalanceBefore = await tokenAFromUser.read.balanceOf([deployer.account.address]);
        const tokenBBalanceBefore = await tokenBFromUser.read.balanceOf([deployer.account.address]);
        const lpBalanceBefore = await readSplTokenAmount(cpiProgram, userPoolLp);

        const removeLiquidityTxHash = await routerFromUser.write.removeLiquidity(
            [
                tokenAAddress,
                tokenBAddress,
                addedLiquidityLpAmount,
                0n,
                0n,
            ],
            {
                account: deployer.account,
            },
        );
        await waitForSuccess(publicClient, removeLiquidityTxHash, "router removeLiquidity");

        const tokenABalanceAfter = await tokenAFromUser.read.balanceOf([deployer.account.address]);
        const tokenBBalanceAfter = await tokenBFromUser.read.balanceOf([deployer.account.address]);
        const lpBalanceAfter = await readSplTokenAmount(cpiProgram, userPoolLp);

        assert.equal(
            lpBalanceAfter,
            lpBalanceBefore - addedLiquidityLpAmount,
            "LP balance must decrease by the removed liquidity amount",
        );
        assert.ok(
            tokenABalanceAfter > tokenABalanceBefore,
            "token A balance must increase after removeLiquidity",
        );
        assert.ok(
            tokenBBalanceAfter > tokenBBalanceBefore,
            "token B balance must increase after removeLiquidity",
        );
    });
});
