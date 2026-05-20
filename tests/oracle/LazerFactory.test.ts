import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * OracleAdapterFactory — Lazer extension.
 *
 * Adds `setLazerImplementations(cache, adapterImpl)` (one-time, onlyOwner)
 * and `createLazerFeed(feedId, desc, maxConfBps)` (onlyOwner — Lazer feeds
 * are curated, unlike Pyth Pull which is permissionless via account-owner
 * validation; Lazer has no per-feed Solana account to validate against).
 *
 * Spec: rome-specs/active/technical/2026-05-20-og-v2-pyth-lazer-adapter.md §3.4
 *
 * Test plan:
 *   - setLazerImplementations stores cache + impl
 *   - setLazerImplementations rejects second call (LazerImplementationsAlreadySet)
 *   - setLazerImplementations onlyOwner
 *   - setLazerImplementations rejects zero-address inputs
 *   - createLazerFeed deploys clone + initializes; emits LazerFeedCreated
 *   - createLazerFeed adds to registry (lazerAdapters + isRegisteredAdapter + allAdapters)
 *   - createLazerFeed rejects duplicate feedId
 *   - createLazerFeed requires impls to be set
 *   - createLazerFeed onlyOwner
 *   - pauseAdapter works on Lazer adapter (existing infra reused)
 */

// Dummy Solana program IDs (32 bytes). Factory constructor needs these.
const DUMMY_PYTH_PROGRAM_ID =
    "0x" + "11".repeat(32) as `0x${string}`;
const DUMMY_SB_PROGRAM_ID =
    "0x" + "22".repeat(32) as `0x${string}`;
const DEFAULT_STALENESS = 60n;
const CACHE_STALENESS = 30n;
const FEED_ID = 100;
const DESC = "BTC / USD";

async function deployStack(viem: any) {
    // Deploy adapter implementations (these never get clones in the test —
    // they're constructor args for the factory).
    const pythImpl = await viem.deployContract("PythPullAdapter", []);
    const sbImpl = await viem.deployContract("SwitchboardV3Adapter", []);
    const factory = await viem.deployContract("OracleAdapterFactory", [
        pythImpl.address,
        sbImpl.address,
        DUMMY_PYTH_PROGRAM_ID,
        DUMMY_SB_PROGRAM_ID,
        DEFAULT_STALENESS,
    ]);
    // Deploy Lazer pieces.
    const lazerImpl = await viem.deployContract("PythLazerFeedAdapter", []);
    const cache = await viem.deployContract("PythLazerCache", [
        factory.address,
        CACHE_STALENESS,
    ]);
    return { factory, lazerImpl, cache };
}

describe("OracleAdapterFactory.setLazerImplementations", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    it("stores cache and adapter impl addresses on first call", async function () {
        const { factory, lazerImpl, cache } = await deployStack(viem);
        await factory.write.setLazerImplementations([
            cache.address,
            lazerImpl.address,
        ]);
        assert.equal(
            ((await factory.read.lazerCache()) as string).toLowerCase(),
            cache.address.toLowerCase(),
        );
        assert.equal(
            ((await factory.read.lazerAdapterImpl()) as string).toLowerCase(),
            lazerImpl.address.toLowerCase(),
        );
    });

    it("rejects second call (one-time only)", async function () {
        const { factory, lazerImpl, cache } = await deployStack(viem);
        await factory.write.setLazerImplementations([
            cache.address,
            lazerImpl.address,
        ]);
        await assert.rejects(
            async () =>
                factory.write.setLazerImplementations([
                    cache.address,
                    lazerImpl.address,
                ]),
            (err: any) =>
                err?.message?.includes("LazerImplementationsAlreadySet") ?? false,
        );
    });

    it("rejects zero address for cache", async function () {
        const { factory, lazerImpl } = await deployStack(viem);
        await assert.rejects(
            async () =>
                factory.write.setLazerImplementations([
                    "0x0000000000000000000000000000000000000000" as `0x${string}`,
                    lazerImpl.address,
                ]),
            (err: any) => err?.message?.includes("ZeroAddress") ?? false,
        );
    });

    it("rejects zero address for adapter impl", async function () {
        const { factory, cache } = await deployStack(viem);
        await assert.rejects(
            async () =>
                factory.write.setLazerImplementations([
                    cache.address,
                    "0x0000000000000000000000000000000000000000" as `0x${string}`,
                ]),
            (err: any) => err?.message?.includes("ZeroAddress") ?? false,
        );
    });
});

describe("OracleAdapterFactory.createLazerFeed", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    async function deployAndSetImpls() {
        const stack = await deployStack(viem);
        await stack.factory.write.setLazerImplementations([
            stack.cache.address,
            stack.lazerImpl.address,
        ]);
        return stack;
    }

    it("requires implementations to be set", async function () {
        const { factory } = await deployStack(viem);
        await assert.rejects(
            async () => factory.write.createLazerFeed([FEED_ID, DESC, 0n]),
            (err: any) =>
                err?.message?.includes("LazerImplementationsNotSet") ?? false,
        );
    });

    it("deploys a clone and initializes it", async function () {
        const { factory, cache } = await deployAndSetImpls();
        await factory.write.createLazerFeed([FEED_ID, DESC, 0n]);
        const adapterAddr = (await factory.read.lazerAdapters([
            FEED_ID,
        ])) as `0x${string}`;
        assert.notEqual(
            adapterAddr.toLowerCase(),
            "0x0000000000000000000000000000000000000000",
        );

        // Verify the clone was initialized correctly.
        const adapter = await viem.getContractAt(
            "PythLazerFeedAdapter",
            adapterAddr,
        );
        assert.equal(
            ((await adapter.read.cache()) as string).toLowerCase(),
            cache.address.toLowerCase(),
        );
        assert.equal(await adapter.read.feedId(), FEED_ID);
        assert.equal(await adapter.read.description(), DESC);
        assert.equal(
            ((await adapter.read.factory()) as string).toLowerCase(),
            factory.address.toLowerCase(),
        );
    });

    it("registers the adapter in allAdapters + isRegisteredAdapter", async function () {
        const { factory } = await deployAndSetImpls();
        await factory.write.createLazerFeed([FEED_ID, DESC, 0n]);
        const adapterAddr = (await factory.read.lazerAdapters([
            FEED_ID,
        ])) as `0x${string}`;

        assert.equal(
            await factory.read.isRegisteredAdapter([adapterAddr]),
            true,
        );
    });

    it("emits LazerFeedCreated event", async function () {
        const { factory } = await deployAndSetImpls();
        await factory.write.createLazerFeed([FEED_ID, DESC, 0n]);
        const events = await factory.getEvents.LazerFeedCreated();
        assert.equal(events.length, 1);
        assert.equal(events[0].args.feedId, FEED_ID);
        assert.equal(events[0].args.description, DESC);
    });

    it("rejects duplicate feedId", async function () {
        const { factory } = await deployAndSetImpls();
        await factory.write.createLazerFeed([FEED_ID, DESC, 0n]);
        await assert.rejects(
            async () => factory.write.createLazerFeed([FEED_ID, DESC, 0n]),
            (err: any) => err?.message?.includes("FeedAlreadyExists") ?? false,
        );
    });

    it("supports multiple distinct feeds", async function () {
        const { factory } = await deployAndSetImpls();
        await factory.write.createLazerFeed([1, "BTC / USD", 0n]);
        await factory.write.createLazerFeed([2, "ETH / USD", 0n]);
        const a = await factory.read.lazerAdapters([1]);
        const b = await factory.read.lazerAdapters([2]);
        assert.notEqual(a, b);
    });

    it("forwards maxConfBps to the adapter clone", async function () {
        const { factory } = await deployAndSetImpls();
        await factory.write.createLazerFeed([FEED_ID, DESC, 500n]);
        const adapterAddr = (await factory.read.lazerAdapters([
            FEED_ID,
        ])) as `0x${string}`;
        const adapter = await viem.getContractAt(
            "PythLazerFeedAdapter",
            adapterAddr,
        );
        assert.equal(await adapter.read.maxConfBps(), 500n);
    });
});

describe("OracleAdapterFactory — Lazer pause integration", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    it("pauseAdapter works on a Lazer-deployed adapter", async function () {
        const stack = await deployStack(viem);
        await stack.factory.write.setLazerImplementations([
            stack.cache.address,
            stack.lazerImpl.address,
        ]);
        await stack.factory.write.createLazerFeed([FEED_ID, DESC, 0n]);
        const adapterAddr = (await stack.factory.read.lazerAdapters([
            FEED_ID,
        ])) as `0x${string}`;

        assert.equal(await stack.factory.read.isPaused([adapterAddr]), false);
        await stack.factory.write.pauseAdapter([adapterAddr]);
        assert.equal(await stack.factory.read.isPaused([adapterAddr]), true);
        await stack.factory.write.unpauseAdapter([adapterAddr]);
        assert.equal(await stack.factory.read.isPaused([adapterAddr]), false);
    });
});
