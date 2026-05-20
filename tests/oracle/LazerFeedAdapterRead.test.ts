import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * PythLazerFeedAdapter — latestRoundData revert paths + happy path + metadata.
 *
 * Sister file to LazerFeedAdapter.test.ts (structural tests).
 *
 * For staleness tests, we use viem's testClient to advance block.timestamp
 * past the cache's maxStaleness window.
 *
 * Spec: rome-specs/active/technical/2026-05-20-og-v2-pyth-lazer-adapter.md §3.3
 */

const STALENESS = 30n;
const FEED_ID = 100;
const DESC = "BTC / USD";

// BTC at $50_000.00 in 8-decimal form
const PRICE_50K = 5_000_000_000_000n;
const CONF_5BPS = 25_000_000n; // 0.05% of 5e12 = 2.5e9, but let's keep low

async function deployStack(viem: any, accounts: any[]) {
    const ownerAccount = accounts[0].account.address;
    const factory = await viem.deployContract("MockAdapterFactoryWithOwner", [
        ownerAccount,
    ]);
    const cache = await viem.deployContract("PythLazerCacheHarness", [
        factory.address,
        STALENESS,
    ]);
    const impl = await viem.deployContract("PythLazerFeedAdapter", []);
    const cloneFactory = await viem.deployContract("AdapterCloneFactory", []);
    return { factory, cache, impl, cloneFactory, ownerAccount };
}

async function deployCloneAndInit(
    viem: any,
    impl: any,
    cloneFactory: any,
    cache: any,
    factory: any,
    feedId: number,
    desc: string,
    maxConfBps: bigint,
) {
    const publicClient = await viem.getPublicClient();
    const txHash = await cloneFactory.write.cloneOf([impl.address]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const events = await cloneFactory.getEvents.Cloned();
    const cloneAddr = events[events.length - 1].args.clone as `0x${string}`;
    const clone = await viem.getContractAt("PythLazerFeedAdapter", cloneAddr);
    await clone.write.initialize([
        cache.address,
        feedId,
        desc,
        maxConfBps,
        factory.address,
    ]);
    return clone;
}

async function writeFeedToCache(
    cache: any,
    feedId: number,
    price: bigint,
    conf: bigint,
    expo: number,
) {
    await cache.write.writeFeedsExt([
        [{ feed_id: feedId, price, conf, expo }],
    ]);
}

describe("PythLazerFeedAdapter.latestRoundData — revert paths", function () {
    let viem: any;
    let accounts: any[];

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        accounts = await viem.getWalletClients();
    });

    it("reverts UninitializedPriceFeed when cache has never been written", async function () {
        const { impl, cache, factory, cloneFactory } = await deployStack(
            viem,
            accounts,
        );
        const clone = await deployCloneAndInit(
            viem,
            impl,
            cloneFactory,
            cache,
            factory,
            FEED_ID,
            DESC,
            0n,
        );
        // Cache is empty for FEED_ID → adapter should revert distinctly.
        await assert.rejects(
            async () => clone.read.latestRoundData(),
            (err: any) =>
                err?.message?.includes("UninitializedPriceFeed") ? true : false,
        );
    });

    it("reverts StalePriceFeed when cache.timestamp + maxStaleness < now", async function () {
        const { impl, cache, factory, cloneFactory } = await deployStack(
            viem,
            accounts,
        );
        const clone = await deployCloneAndInit(
            viem,
            impl,
            cloneFactory,
            cache,
            factory,
            FEED_ID,
            DESC,
            0n,
        );
        // Write valid price.
        await writeFeedToCache(cache, FEED_ID, PRICE_50K, CONF_5BPS, -8);

        // Advance time past staleness.
        const testClient = await viem.getTestClient();
        await testClient.increaseTime({ seconds: 31 });
        await testClient.mine({ blocks: 1 });

        await assert.rejects(
            async () => clone.read.latestRoundData(),
            (err: any) =>
                err?.message?.includes("StalePriceFeed") ? true : false,
        );
    });

    it("reverts NonPositivePrice when cached answer is zero", async function () {
        const { impl, cache, factory, cloneFactory } = await deployStack(
            viem,
            accounts,
        );
        const clone = await deployCloneAndInit(
            viem,
            impl,
            cloneFactory,
            cache,
            factory,
            FEED_ID,
            DESC,
            0n,
        );
        // Write a zero price (normalized still zero).
        await writeFeedToCache(cache, FEED_ID, 0n, 0n, -8);

        await assert.rejects(
            async () => clone.read.latestRoundData(),
            (err: any) =>
                err?.message?.includes("NonPositivePrice") ? true : false,
        );
    });

    it("reverts NonPositivePrice when cached answer is negative", async function () {
        const { impl, cache, factory, cloneFactory } = await deployStack(
            viem,
            accounts,
        );
        const clone = await deployCloneAndInit(
            viem,
            impl,
            cloneFactory,
            cache,
            factory,
            FEED_ID,
            DESC,
            0n,
        );
        // Lazer can encode negative prices (rare — e.g. funding rate).
        // Adapter rejects them for the Chainlink-compat path.
        await writeFeedToCache(cache, FEED_ID, -100n, 0n, -8);

        await assert.rejects(
            async () => clone.read.latestRoundData(),
            (err: any) =>
                err?.message?.includes("NonPositivePrice") ? true : false,
        );
    });

    it("reverts ConfidenceExceedsThreshold when conf/answer > maxConfBps", async function () {
        const { impl, cache, factory, cloneFactory } = await deployStack(
            viem,
            accounts,
        );
        // Use default maxConfBps = 200 (2%).
        const clone = await deployCloneAndInit(
            viem,
            impl,
            cloneFactory,
            cache,
            factory,
            FEED_ID,
            DESC,
            0n,
        );
        // conf = 3% of price → conf/answer = 0.03 = 300 bps > 200.
        const price = 100_000_000n; // $1.00 at 8 decimals
        const conf = 3_000_000n;    // 3% of price
        await writeFeedToCache(cache, FEED_ID, price, conf, -8);

        await assert.rejects(
            async () => clone.read.latestRoundData(),
            (err: any) =>
                err?.message?.includes("ConfidenceExceedsThreshold") ? true : false,
        );
    });

    it("reverts AdapterPaused when factory reports paused", async function () {
        const { impl, cache, factory, cloneFactory } = await deployStack(
            viem,
            accounts,
        );
        const clone = await deployCloneAndInit(
            viem,
            impl,
            cloneFactory,
            cache,
            factory,
            FEED_ID,
            DESC,
            0n,
        );
        // Write valid price.
        await writeFeedToCache(cache, FEED_ID, PRICE_50K, CONF_5BPS, -8);
        // Pause via mock factory.
        await factory.write.setPaused([clone.address, true]);

        await assert.rejects(
            async () => clone.read.latestRoundData(),
            (err: any) =>
                err?.message?.includes("AdapterPaused") ? true : false,
        );
    });
});

describe("PythLazerFeedAdapter.latestRoundData — happy path", function () {
    let viem: any;
    let accounts: any[];

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        accounts = await viem.getWalletClients();
    });

    it("returns expected tuple after fresh write", async function () {
        const { impl, cache, factory, cloneFactory } = await deployStack(
            viem,
            accounts,
        );
        const clone = await deployCloneAndInit(
            viem,
            impl,
            cloneFactory,
            cache,
            factory,
            FEED_ID,
            DESC,
            0n,
        );
        await writeFeedToCache(cache, FEED_ID, PRICE_50K, CONF_5BPS, -8);

        const result: any = await clone.read.latestRoundData();
        // tuple: (roundId, answer, startedAt, updatedAt, answeredInRound)
        assert.equal(result[0], 1n);                    // first write → roundId == 1
        assert.equal(result[1], PRICE_50K);             // normalized answer
        assert.notEqual(result[2], 0n);                 // startedAt = timestamp
        assert.equal(result[2], result[3]);             // startedAt == updatedAt
        assert.equal(result[4], 1n);                    // answeredInRound
    });

    it("returns updated roundId on subsequent refresh", async function () {
        const { impl, cache, factory, cloneFactory } = await deployStack(
            viem,
            accounts,
        );
        const clone = await deployCloneAndInit(
            viem,
            impl,
            cloneFactory,
            cache,
            factory,
            FEED_ID,
            DESC,
            0n,
        );
        await writeFeedToCache(cache, FEED_ID, PRICE_50K, CONF_5BPS, -8);
        await writeFeedToCache(cache, FEED_ID, PRICE_50K, CONF_5BPS, -8);

        const result: any = await clone.read.latestRoundData();
        assert.equal(result[0], 2n);
        assert.equal(result[4], 2n);
    });
});

describe("PythLazerFeedAdapter.metadata", function () {
    let viem: any;
    let accounts: any[];

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        accounts = await viem.getWalletClients();
    });

    it("returns full struct with right fields", async function () {
        const { impl, cache, factory, cloneFactory } = await deployStack(
            viem,
            accounts,
        );
        const clone = await deployCloneAndInit(
            viem,
            impl,
            cloneFactory,
            cache,
            factory,
            FEED_ID,
            DESC,
            300n,
        );

        const m: any = await clone.read.metadata();
        assert.equal(m.description, DESC);
        assert.equal(m.sourceType, 0); // OracleSource.Pyth — Lazer is Pyth's product line; future PR adds OracleSource.PythLazer = 2
        assert.equal(
            m.solanaAccount,
            "0x0000000000000000000000000000000000000000000000000000000000000000",
        );
        assert.equal(m.maxStaleness, STALENESS);
        assert.notEqual(m.createdAt, 0n);
        assert.equal(
            (m.factory as string).toLowerCase(),
            factory.address.toLowerCase(),
        );
        assert.equal(m.paused, false);
    });

    it("reflects paused state live from factory", async function () {
        const { impl, cache, factory, cloneFactory } = await deployStack(
            viem,
            accounts,
        );
        const clone = await deployCloneAndInit(
            viem,
            impl,
            cloneFactory,
            cache,
            factory,
            FEED_ID,
            DESC,
            0n,
        );
        const before: any = await clone.read.metadata();
        assert.equal(before.paused, false);

        await factory.write.setPaused([clone.address, true]);
        const after: any = await clone.read.metadata();
        assert.equal(after.paused, true);
    });
});
