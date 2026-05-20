import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * PythLazerFeedAdapter — per-feed Chainlink-compat clone over PythLazerCache.
 *
 * Tests use AdapterCloneFactory (existing test helper) to deploy clones of
 * the implementation, then initialize them.
 *
 * Test plan:
 *  Structural / init:
 *   - Implementation contract is locked (direct initialize reverts)
 *   - Clone initialize sets fields correctly
 *   - Second initialize on the same clone reverts
 *   - initialize with maxConfBps > 1000 reverts
 *   - initialize with maxConfBps == 0 falls back to default 200
 *
 *  IAggregatorV3:
 *   - decimals() returns 8 (constant)
 *   - version() returns 1
 *   - description() returns initialized desc
 *   - getRoundData reverts HistoricalRoundsNotSupported
 *
 *  latestRoundData paths:
 *   - cold-start → UninitializedPriceFeed
 *   - stale → StalePriceFeed
 *   - non-positive answer → NonPositivePrice
 *   - confidence too high → ConfidenceExceedsThreshold
 *   - paused → AdapterPaused
 *   - happy path returns expected tuple
 *
 *  Metadata:
 *   - metadata() returns shape with right fields
 *
 * Spec: rome-specs/active/technical/2026-05-20-og-v2-pyth-lazer-adapter.md §3.3
 */

const FACTORY_OWNER_PRIVKEY = 0;
const STALENESS = 30n;
const FEED_ID = 100;
const DESC = "BTC / USD";

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
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    // Cloned event has args (implementation, clone).
    const events = await cloneFactory.getEvents.Cloned();
    const cloneAddr = events[events.length - 1].args.clone as `0x${string}`;

    const clone = await viem.getContractAt(
        "PythLazerFeedAdapter",
        cloneAddr,
    );
    await clone.write.initialize([
        cache.address,
        feedId,
        desc,
        maxConfBps,
        factory.address,
    ]);
    return clone;
}

describe("PythLazerFeedAdapter — implementation lock", function () {
    let viem: any;
    let accounts: any[];

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        accounts = await viem.getWalletClients();
    });

    it("implementation rejects direct initialize", async function () {
        const { impl, cache, factory } = await deployStack(viem, accounts);
        await assert.rejects(
            async () =>
                impl.write.initialize([
                    cache.address,
                    FEED_ID,
                    DESC,
                    0n,
                    factory.address,
                ]),
            (err: any) =>
                err?.message?.includes("AlreadyInitialized") ||
                // Selector fallback: keccak256("AlreadyInitialized()")[:4]
                err?.message?.includes("0x0dc149f0")
                    ? true
                    : false,
        );
    });
});

describe("PythLazerFeedAdapter — initialize", function () {
    let viem: any;
    let accounts: any[];

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        accounts = await viem.getWalletClients();
    });

    it("sets fields after first initialize", async function () {
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

        assert.equal(
            ((await clone.read.cache()) as string).toLowerCase(),
            cache.address.toLowerCase(),
        );
        assert.equal(await clone.read.feedId(), FEED_ID);
        assert.equal(await clone.read.description(), DESC);
        assert.equal(
            ((await clone.read.factory()) as string).toLowerCase(),
            factory.address.toLowerCase(),
        );
        assert.equal(await clone.read.initialized(), true);
        assert.equal(await clone.read.maxConfBps(), 200n); // default when 0 passed
    });

    it("second initialize reverts AlreadyInitialized", async function () {
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

        await assert.rejects(
            async () =>
                clone.write.initialize([
                    cache.address,
                    FEED_ID + 1,
                    DESC,
                    0n,
                    factory.address,
                ]),
            (err: any) =>
                err?.message?.includes("AlreadyInitialized") ||
                err?.message?.includes("0x0dc149f0")
                    ? true
                    : false,
        );
    });

    it("rejects maxConfBps > 1000", async function () {
        const { impl, cache, factory, cloneFactory } = await deployStack(
            viem,
            accounts,
        );
        await assert.rejects(
            async () =>
                deployCloneAndInit(
                    viem,
                    impl,
                    cloneFactory,
                    cache,
                    factory,
                    FEED_ID,
                    DESC,
                    1001n,
                ),
            (err: any) =>
                err?.message?.includes("MaxConfBpsOutOfRange") ? true : false,
        );
    });

    it("uses caller-supplied maxConfBps when non-zero", async function () {
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
            500n,
        );
        assert.equal(await clone.read.maxConfBps(), 500n);
    });
});

describe("PythLazerFeedAdapter — IAggregatorV3 read-only", function () {
    let viem: any;
    let accounts: any[];

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        accounts = await viem.getWalletClients();
    });

    it("decimals() returns 8 (constant, Chainlink convention)", async function () {
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
        assert.equal(await clone.read.decimals(), 8);
    });

    it("version() returns 1", async function () {
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
        assert.equal(await clone.read.version(), 1n);
    });

    it("getRoundData reverts HistoricalRoundsNotSupported", async function () {
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
        await assert.rejects(
            async () => clone.read.getRoundData([1n]),
            (err: any) =>
                err?.message?.includes("HistoricalRoundsNotSupported")
                    ? true
                    : false,
        );
    });
});
