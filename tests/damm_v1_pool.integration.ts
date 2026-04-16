import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { readDeployments, PoolDeployment, DeploymentsFile } from "../scripts/lib/deployments.js";
import { requireEnv } from "../scripts/lib/helpers.js";


function isHex32(value: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isHex20(value: string): boolean {
    return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isZeroBytes32(value: string): boolean {
    return /^0x0{64}$/i.test(value);
}

function pickPoolDeployment(deployments: DeploymentsFile): {
    pubkey: string;
    address: `0x${string}`;
} {
    const pools = deployments.MeteoraDAMMv1Pools ?? [];
    if (pools.length === 0) {
        throw new Error(
            "No MeteoraDAMMv1Pools found in deployments file. Deploy a pool first.",
        );
    }

    const wantedPubkey = process.env.POOL_PUBKEY?.toLowerCase();
    if (wantedPubkey) {
        const found = pools.find((p: PoolDeployment) => p.pubkey.toLowerCase() === wantedPubkey);
        if (!found) {
            throw new Error(
                `POOL_PUBKEY=${process.env.POOL_PUBKEY} not found in deployments file.`,
            );
        }

        return {
            pubkey: found.pubkey,
            address: found.address as `0x${string}`,
        };
    }

    const latest = pools[pools.length - 1];
    return {
        pubkey: latest.pubkey,
        address: latest.address as `0x${string}`,
    };
}

describe("DAMMv1Pool integration", function () {
    let poolAddress: `0x${string}`;
    let poolPubkey: string;
    let selectedPool: PoolDeployment;
    let pool: any;
    let erc20pool: any;
    let publicClient: Awaited<ReturnType<(typeof hardhat)["network"]["connect"]>>["viem"] extends infer V
        ? V extends { getPublicClient: () => Promise<infer P> }
            ? P
            : never
        : never;

    before(async function () {
        const { viem, networkName } = await hardhat.network.connect();
        publicClient = await viem.getPublicClient();

        const deployments = readDeployments(networkName);
        const selected = pickPoolDeployment(deployments);
        selectedPool = deployments.MeteoraDAMMv1Pools?.find(
            (poolDeployment) =>
                poolDeployment.pubkey.toLowerCase() === selected.pubkey.toLowerCase()
                || poolDeployment.address.toLowerCase() === selected.address.toLowerCase(),
        ) ?? {
            pubkey: selected.pubkey,
            address: selected.address,
            txHash: "",
            blockNumber: "0",
        };

        poolAddress = selected.address;
        poolPubkey = selected.pubkey;

        erc20pool = await viem.getContractAt("ERC20DAMMv1Pool", poolAddress);
        pool = await viem.getContractAt("DAMMv1Pool", await erc20pool.read.internal_pool());

        const code = await publicClient.getCode({ address: poolAddress });
        assert.ok(code && code !== "0x", `No contract code at ${poolAddress}`);

        console.log("Testing ERC20DAMMv1Pool at:", poolAddress);
        console.log("Expected pool pubkey:", poolPubkey);
    });

    it("has correct immutable-like core addresses/state initialized", async function () {
        const onchainPoolAddress = await pool.read.pool_address();
        const progDynamicVault = await pool.read.prog_dynamic_vault();
        const progDynamicAmm = await pool.read.prog_dynamic_amm();

        assert.equal(
            onchainPoolAddress.toLowerCase(),
            poolPubkey.toLowerCase(),
            "pool_address does not match deployment record pubkey",
        );

        assert.ok(isHex32(onchainPoolAddress), "pool_address must be bytes32");
        assert.ok(isHex32(progDynamicVault), "prog_dynamic_vault must be bytes32");
        assert.ok(isHex32(progDynamicAmm), "prog_dynamic_amm must be bytes32");

        assert.ok(!isZeroBytes32(progDynamicVault), "prog_dynamic_vault must not be zero");
        assert.ok(!isZeroBytes32(progDynamicAmm), "prog_dynamic_amm must not be zero");
    });

    it("has non-empty parsed pool state fields", async function () {
        const lpMint = await pool.read.lp_mint();
        const tokenAMint = await pool.read.token_a_mint();
        const tokenBMint = await pool.read.token_b_mint();
        const aVault = await pool.read.a_vault();
        const bVault = await pool.read.b_vault();
        const aVaultLp = await pool.read.a_vault_lp();
        const bVaultLp = await pool.read.b_vault_lp();

        assert.ok(isHex32(lpMint), "lp_mint must be bytes32");
        assert.ok(isHex32(tokenAMint), "token_a_mint must be bytes32");
        assert.ok(isHex32(tokenBMint), "token_b_mint must be bytes32");
        assert.ok(isHex32(aVault), "a_vault must be bytes32");
        assert.ok(isHex32(bVault), "b_vault must be bytes32");
        assert.ok(isHex32(aVaultLp), "a_vault_lp must be bytes32");
        assert.ok(isHex32(bVaultLp), "b_vault_lp must be bytes32");

        assert.ok(!isZeroBytes32(lpMint), "lp_mint must not be zero");
        assert.ok(!isZeroBytes32(tokenAMint), "token_a_mint must not be zero");
        assert.ok(!isZeroBytes32(tokenBMint), "token_b_mint must not be zero");
        assert.ok(!isZeroBytes32(aVault), "a_vault must not be zero");
        assert.ok(!isZeroBytes32(bVault), "b_vault must not be zero");
        assert.ok(!isZeroBytes32(aVaultLp), "a_vault_lp must not be zero");
        assert.ok(!isZeroBytes32(bVaultLp), "b_vault_lp must not be zero");

        assert.notEqual(
            tokenAMint.toLowerCase(),
            tokenBMint.toLowerCase(),
            "token_a_mint and token_b_mint must differ",
        );
        assert.notEqual(
            aVault.toLowerCase(),
            bVault.toLowerCase(),
            "a_vault and b_vault must differ",
        );
    });

    it("returns vault structs with sane values", async function () {
        const vaultA = await pool.read.vault_a();
        const vaultB = await pool.read.vault_b();

        const vaultAEnabled = vaultA[0];
        const vaultABumps = vaultA[1];
        const vaultATotalAmount = vaultA[2];
        const vaultATokenVault = vaultA[3];
        const vaultAFeeVault = vaultA[4];
        const vaultATokenMint = vaultA[5];
        const vaultALpMint = vaultA[6];
        const vaultALockedProfitTracker = vaultA[7];

        const vaultBEnabled = vaultB[0];
        const vaultBBumps = vaultB[1];
        const vaultBTotalAmount = vaultB[2];
        const vaultBTokenVault = vaultB[3];
        const vaultBFeeVault = vaultB[4];
        const vaultBTokenMint = vaultB[5];
        const vaultBLpMint = vaultB[6];
        const vaultBLockedProfitTracker = vaultB[7];

        assert.ok(typeof vaultAEnabled === "number", "vault_a.enabled must be number");
        assert.ok(typeof vaultBEnabled === "number", "vault_b.enabled must be number");

        assert.ok(typeof vaultABumps.vault_bump === "number", "vault_a.bumps.vault_bump must be number");
        assert.ok(typeof vaultABumps.token_vault_bump === "number", "vault_a.bumps.token_vault_bump must be number");
        assert.ok(typeof vaultBBumps.vault_bump === "number", "vault_b.bumps.vault_bump must be number");
        assert.ok(typeof vaultBBumps.token_vault_bump === "number", "vault_b.bumps.token_vault_bump must be number");

        assert.ok(typeof vaultATotalAmount === "bigint", "vault_a.total_amount must be bigint");
        assert.ok(typeof vaultBTotalAmount === "bigint", "vault_b.total_amount must be bigint");

        assert.ok(isHex32(vaultATokenVault), "vault_a.token_vault must be bytes32");
        assert.ok(isHex32(vaultAFeeVault), "vault_a.fee_vault must be bytes32");
        assert.ok(isHex32(vaultATokenMint), "vault_a.token_mint must be bytes32");
        assert.ok(isHex32(vaultALpMint), "vault_a.lp_mint must be bytes32");

        assert.ok(isHex32(vaultBTokenVault), "vault_b.token_vault must be bytes32");
        assert.ok(isHex32(vaultBFeeVault), "vault_b.fee_vault must be bytes32");
        assert.ok(isHex32(vaultBTokenMint), "vault_b.token_mint must be bytes32");
        assert.ok(isHex32(vaultBLpMint), "vault_b.lp_mint must be bytes32");

        assert.ok(vaultATotalAmount >= 0n, "vault_a.total_amount must be non-negative");
        assert.ok(vaultBTotalAmount >= 0n, "vault_b.total_amount must be non-negative");

        assert.ok(
            typeof vaultALockedProfitTracker.last_updated_locked_profit === "bigint",
            "vault_a.locked_profit_tracker.last_updated_locked_profit must be bigint",
        );
        assert.ok(
            typeof vaultALockedProfitTracker.last_report === "bigint",
            "vault_a.locked_profit_tracker.last_report must be bigint",
        );
        assert.ok(
            typeof vaultALockedProfitTracker.locked_profit_degradation === "bigint",
            "vault_a.locked_profit_tracker.locked_profit_degradation must be bigint",
        );

        assert.ok(
            typeof vaultBLockedProfitTracker.last_updated_locked_profit === "bigint",
            "vault_b.locked_profit_tracker.last_updated_locked_profit must be bigint",
        );
        assert.ok(
            typeof vaultBLockedProfitTracker.last_report === "bigint",
            "vault_b.locked_profit_tracker.last_report must be bigint",
        );
        assert.ok(
            typeof vaultBLockedProfitTracker.locked_profit_degradation === "bigint",
            "vault_b.locked_profit_tracker.locked_profit_degradation must be bigint",
        );
    });

    it("returns reserves", async function () {
        const reserves = await pool.read.get_reserves();

        assert.ok(
            typeof reserves.a_reserve === "bigint",
            "a_reserve must be bigint",
        );
        assert.ok(
            typeof reserves.b_reserve === "bigint",
            "b_reserve must be bigint",
        );

        assert.ok(reserves.a_reserve >= 0n, "a_reserve must be >= 0");
        assert.ok(reserves.b_reserve >= 0n, "b_reserve must be >= 0");
    });

    it("returns price for TokenA and TokenB when reserves are non-zero", async function () {
        const reserves = await pool.read.get_reserves();

        if (reserves.a_reserve === 0n || reserves.b_reserve === 0n) {
            this.skip();
            return;
        }

        const priceA = await pool.read.get_price_e18([0]); // PoolToken.TokenA
        const priceB = await pool.read.get_price_e18([1]); // PoolToken.TokenB

        assert.ok(priceA > 0n, "priceA must be > 0");
        assert.ok(priceB > 0n, "priceB must be > 0");
    });

    it("returns fees in e18 when denominators are non-zero", async function () {
        const fees = await pool.read.fees();
        const tradeFeeDenominator = fees[1];
        const protocolTradeFeeDenominator = fees[3];

        assert.ok(
            tradeFeeDenominator > 0n,
            "trade_fee_denominator must be > 0 for get_fees_e18 test",
        );
        assert.ok(
            protocolTradeFeeDenominator > 0n,
            "protocol_trade_fee_denominator must be > 0 for get_fees_e18 test",
        );

        const feeE18 = await pool.read.get_fees_e18();
        assert.ok(feeE18 >= 0n, "feeE18 must be >= 0");
    });

    it("protocol fee accounts are valid bytes32 values", async function () {
        const protocolTokenAFee = await pool.read.protocol_token_a_fee();
        const protocolTokenBFee = await pool.read.protocol_token_b_fee();

        assert.ok(isHex32(protocolTokenAFee), "protocol_token_a_fee must be bytes32");
        assert.ok(isHex32(protocolTokenBFee), "protocol_token_b_fee must be bytes32");
    });

    it("deployed contract address is a valid EVM address", async function () {
        assert.ok(isHex20(poolAddress), `Pool address is not a valid EVM address: ${poolAddress}`);
    });

    it("can optionally refresh cached state via update_state()", async function () {
        const { viem } = await hardhat.network.connect();
        const [deployer] = await viem.getWalletClients();
        if (!deployer?.account) {
            throw new Error("No deployer wallet available for write test.");
        }

        const txHash = await pool.write.update_state([], {
            account: deployer.account,
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        assert.equal(receipt.status, "success", "update_state tx failed");
    });

    it("can invoke_swap via explicit accounts", async function () {
        const tokenIn = 0;
        const amountIn = BigInt(10000);
        const minAmountOut = 0n;

        const { viem, networkName } = await hardhat.network.connect();
        const [deployer] = await viem.getWalletClients();
        if (!deployer?.account) {
            throw new Error("No deployer wallet available for invoke_swap test.");
        }

        const deployments = readDeployments(networkName);
        const erc20SplFactoryAddress = deployments.ERC20SPLFactory?.address;
        if (!erc20SplFactoryAddress) {
            console.log("erc20SplFactory deployment not found");
            this.skip();
            return;
        }

        const tokenInAddress = (tokenIn === 0
            ? selectedPool.tokenAAddress
            : selectedPool.tokenBAddress) as `0x${string}`;
        const tokenOutAddress = (tokenIn === 0
            ? selectedPool.tokenBAddress
            : selectedPool.tokenAAddress) as `0x${string}`;

        const tokenInContract = await viem.getContractAt("SPL_ERC20", tokenInAddress, {
            client: {
                public: publicClient,
                wallet: deployer,
            },
        });
        const tokenOutContract = await viem.getContractAt("SPL_ERC20", tokenOutAddress, {
            client: {
                public: publicClient,
                wallet: deployer,
            },
        });
        const erc20SplFactory = await viem.getContractAt("ERC20SPLFactory", erc20SplFactoryAddress, {
            client: {
                public: publicClient,
                wallet: deployer,
            },
        });
        const usersAddress = await erc20SplFactory.read.users();
        const users = await viem.getContractAt("ERC20Users", usersAddress, {
            client: {
                public: publicClient,
                wallet: deployer,
            },
        });

        try {
            await users.read.get_user([deployer.account.address]);
        } catch {
            const createUserTxHash = await erc20SplFactory.write.create_user([], {
                account: deployer.account,
            });
            const createUserReceipt = await publicClient.waitForTransactionReceipt({ hash: createUserTxHash });
            assert.equal(createUserReceipt.status, "success", "create_user tx failed");
        }

        const payer = await users.read.get_user([deployer.account.address]);
        console.log("Payer is ", payer);

        for (const [tokenContract, label] of [
            [tokenInContract, "token in"],
            [tokenOutContract, "token out"],
        ] as const) {
            try {
                await tokenContract.read.get_token_account([deployer.account.address]);
            } catch {
                const ensureAccountTxHash = await tokenContract.write.ensure_token_account([deployer.account.address], {
                    account: deployer.account,
                });
                const ensureAccountReceipt = await publicClient.waitForTransactionReceipt({ hash: ensureAccountTxHash });
                assert.equal(ensureAccountReceipt.status, "success", `ensure ${label} token account tx failed`);
            }
        }

        const debugSwapAccounts = await erc20pool.read.debugSwapExactTokensForTokens(
            [payer, tokenInAddress, amountIn, minAmountOut],
            {
                account: deployer.account.address,
            },
        );

        console.log("Prog dynamic AMM: ", await pool.read.prog_dynamic_amm());
        assert.equal(debugSwapAccounts.length, 15, "debugSwapExactTokensForTokens must return 15 account metas");
        assert.equal(debugSwapAccounts[0].pubkey.toLowerCase(), poolPubkey.toLowerCase(), "pool meta must match pool pubkey");
        assert.equal(debugSwapAccounts[12].is_signer, true, "user meta must be signer");
        assert.equal(debugSwapAccounts[13].pubkey.toLowerCase(), (await pool.read.prog_dynamic_vault()).toLowerCase(), "vault program meta must match");

        console.log("User input token account ", await tokenInContract.read.get_token_account([deployer.account.address]));

        const inputBalanceBefore = await tokenInContract.read.balanceOf([deployer.account.address]);
        const outputBalanceBefore = await tokenOutContract.read.balanceOf([deployer.account.address]);

        assert.ok(
            inputBalanceBefore >= amountIn,
            `swap user must hold at least ${amountIn} input tokens before swap`,
        );

        const swapTxHash = await erc20pool.write.swapExactTokensForTokens(
            [tokenInAddress, amountIn, minAmountOut],
            {
                account: deployer.account,
            },
        );
        const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapTxHash });
        assert.equal(swapReceipt.status, "success", "swapExactTokensForTokens tx failed");

        const inputBalanceAfter = await tokenInContract.read.balanceOf([deployer.account.address]);
        const outputBalanceAfter = await tokenOutContract.read.balanceOf([deployer.account.address]);

        assert.equal(
            inputBalanceAfter,
            inputBalanceBefore - amountIn,
            "input token balance must decrease by the swap amount",
        );
        assert.ok(
            outputBalanceAfter > outputBalanceBefore,
            "output token balance must increase after swap",
        );
    });
});
