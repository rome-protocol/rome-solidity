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
    let userRecord: any;

    let poolPubkey: `0x${string}`;
    let wrappedPoolAddress: `0x${string}`;

    const mintAmount = 2_000_000_000_000n;
    const poolTokenAAmount = 500_000_000_000n;
    const poolTokenBAmount = 500_000_000_000n;
    const swapAmountIn = 100_000_000n;
    const minAmountOut = 0n;
    const tradeFeeBps = 25n;

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
        userRecord = await users.read.get_user([deployer.account.address]);

        const configuredTokenFactoryAddress = getAddress(await factory.read.token_factory());
        assert.equal(
            configuredTokenFactoryAddress.toLowerCase(),
            erc20SplFactoryAddress.toLowerCase(),
            "MeteoraDAMMv1Factory must be configured with the deployed ERC20SPLFactory",
        );

        assert.ok(isHex32(userRecord.payer), "User.payer must be bytes32");
        assert.ok(isHex32(userRecord.owner), "User.owner must be bytes32");
        assert.notEqual(userRecord.payer, `0x${"0".repeat(64)}`, "User.payer must not be zero");
        assert.notEqual(userRecord.owner, `0x${"0".repeat(64)}`, "User.owner must not be zero");

        const cpiProgramAddress = await factory.read.cpi_program();
        cpiProgram = await viem.getContractAt("ICrossProgramInvocation", cpiProgramAddress);
        const payerAccountInfo = await cpiProgram.read.account_info([userRecord.payer]);
        assert.ok(payerAccountInfo[0] > 0n, "User.payer Solana account must exist and be funded");

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

        await ensureTokenAccount(tokenAFromUser, publicClient, deployer, "ensure token A account");
        await ensureTokenAccount(tokenBFromUser, publicClient, deployer, "ensure token B account");

        const previewVaultA = await factory.read.previewInitializeVault([tokenAMint, deployer.account.address]);
        const previewVaultB = await factory.read.previewInitializeVault([tokenBMint, deployer.account.address]);
        assert.equal(previewVaultA[1].payer.toLowerCase(), userRecord.payer.toLowerCase(), "vault A payer must match User.payer");
        assert.equal(previewVaultB[1].payer.toLowerCase(), userRecord.payer.toLowerCase(), "vault B payer must match User.payer");

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

        poolPubkey = await factory.read.derivePermissionlessPoolKeyWithFeeTier([
            tokenAMint,
            tokenBMint,
            tradeFeeBps,
        ]);

        const createPoolTxHash = await factoryFromUser.write.createPermissionlessPoolWithFeeTier(
            [
                tokenAMint,
                tokenBMint,
                tradeFeeBps,
                poolTokenAAmount,
                poolTokenBAmount,
            ],
            {
                account: deployer.account,
            },
        );
        await waitForSuccess(publicClient, createPoolTxHash, "create permissionless pool");

        const addPoolSimulation = await factoryFromUser.simulate.addPool([poolPubkey], {
            account: deployer.account,
        });
        const rawPoolAddress = getAddress(addPoolSimulation.result);

        const addPoolTxHash = await factoryFromUser.write.addPool(addPoolSimulation.request);
        await waitForSuccess(publicClient, addPoolTxHash, "register wrapped pool");

        const poolCount = await factory.read.allPoolsLength();
        wrappedPoolAddress = getAddress(await factory.read.allPools([poolCount - 1n]));
        assert.notEqual(rawPoolAddress, zeroAddress, "raw pool address must not be zero");

        console.log("Testing MeteoraDAMMv1Factory at:", factoryAddress);
        console.log("Testing MeteoraDAMMv1Router at:", routerAddress);
        console.log("Using ERC20SPLFactory at:", erc20SplFactoryAddress);
        console.log("Created token A mint:", tokenAMint);
        console.log("Created token B mint:", tokenBMint);
        console.log("Created pool pubkey:", poolPubkey);
        console.log("Created wrapped pool:", wrappedPoolAddress);
        console.log("Swap user:", deployer.account.address);
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
