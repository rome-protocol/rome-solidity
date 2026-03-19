import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { readDeployments, PoolDeployment, DeploymentsFile } from "../scripts/lib/deployments.js";


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
    let pool: any;
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

        poolAddress = selected.address;
        poolPubkey = selected.pubkey;

        pool = await viem.getContractAt("DAMMv1Pool", poolAddress);

        const code = await publicClient.getCode({ address: poolAddress });
        assert.ok(code && code !== "0x", `No contract code at ${poolAddress}`);

        console.log("Testing DAMMv1Pool at:", poolAddress);
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

        assert.ok(isHex32(vaultA.token_vault), "vault_a.token_vault must be bytes32");
        assert.ok(isHex32(vaultA.fee_vault), "vault_a.fee_vault must be bytes32");
        assert.ok(isHex32(vaultA.token_mint), "vault_a.token_mint must be bytes32");
        assert.ok(isHex32(vaultA.lp_mint), "vault_a.lp_mint must be bytes32");

        assert.ok(isHex32(vaultB.token_vault), "vault_b.token_vault must be bytes32");
        assert.ok(isHex32(vaultB.fee_vault), "vault_b.fee_vault must be bytes32");
        assert.ok(isHex32(vaultB.token_mint), "vault_b.token_mint must be bytes32");
        assert.ok(isHex32(vaultB.lp_mint), "vault_b.lp_mint must be bytes32");

        assert.ok(vaultA.total_amount >= 0n, "vault_a.total_amount must be non-negative");
        assert.ok(vaultB.total_amount >= 0n, "vault_b.total_amount must be non-negative");
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

        assert.ok(
            fees.trade_fee_denominator > 0n,
            "trade_fee_denominator must be > 0 for get_fees_e18 test",
        );
        assert.ok(
            fees.protocol_trade_fee_denominator > 0n,
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
        if (process.env.RUN_WRITE_TESTS !== "1") {
            this.skip();
            return;
        }

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
});
