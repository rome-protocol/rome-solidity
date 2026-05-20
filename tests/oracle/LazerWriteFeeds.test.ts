import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * PythLazerCache._writeFeeds (via harness) — the core write path that
 * refresh() invokes after parsing the envelope via helper.lazer_price.
 *
 * We unit-test the write path in isolation by exposing _writeFeeds on
 * the harness as `writeFeedsExt`. The full refresh() path goes through
 * the IHelperProgram precompile and is exercised end-to-end via Hadrian
 * integration test.
 *
 * Cycles covered:
 *   5. write a single feed → stored with normalized answer + confidence
 *   5b. write a multi-feed envelope → all stored
 *   6. monotonic roundId per feed (re-write increments)
 *   7. PriceUpdated event emitted per feed
 *
 * Spec: rome-specs/active/technical/2026-05-20-og-v2-pyth-lazer-adapter.md §3.2
 *
 * LazerFeedPrice struct shape (from contracts/interface.sol):
 *   { uint32 feed_id; int64 price; uint64 conf; int32 expo; }
 * In viem this becomes a positional tuple [feed_id, price, conf, expo].
 */
describe("PythLazerCache._writeFeeds — single feed", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    const FACTORY = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const STALENESS = 30n;

    async function deployHarness() {
        return await viem.deployContract("PythLazerCacheHarness", [
            FACTORY,
            STALENESS,
        ]);
    }

    it("stores answer normalized to 8 decimals", async function () {
        const h = await deployHarness();
        // BTC at $50,000, expo -8 (already 8 decimals)
        const feeds = [
            { feed_id: 1, price: 5_000_000_000_000n, conf: 50_000_000n, expo: -8 },
        ];
        await h.write.writeFeedsExt([feeds]);
        const got: any = await h.read.getPrice([1]);
        assert.equal(got.answer, 5_000_000_000_000n);
        assert.equal(got.confidence, 50_000_000n);
    });

    it("stores feed_id-keyed in the prices mapping", async function () {
        const h = await deployHarness();
        const feeds = [
            { feed_id: 42, price: 100n, conf: 0n, expo: -8 },
        ];
        await h.write.writeFeedsExt([feeds]);
        // Wrong feedId returns zero
        const wrong: any = await h.read.getPrice([99]);
        assert.equal(wrong.timestamp, 0n);
        // Right feedId returns the write
        const right: any = await h.read.getPrice([42]);
        assert.equal(right.answer, 100n);
    });

    it("scales answer + conf when expo != -8", async function () {
        const h = await deployHarness();
        // expo -12 → divide by 10000
        const feeds = [
            { feed_id: 7, price: 1_234_567_890_000_000n, conf: 1_000_000n, expo: -12 },
        ];
        await h.write.writeFeedsExt([feeds]);
        const got: any = await h.read.getPrice([7]);
        assert.equal(got.answer, 123_456_789_000n);
        assert.equal(got.confidence, 100n); // 1_000_000 / 10000 = 100
    });

    it("sets timestamp to block.timestamp at write", async function () {
        const h = await deployHarness();
        const feeds = [{ feed_id: 1, price: 100n, conf: 0n, expo: -8 }];
        await h.write.writeFeedsExt([feeds]);
        const got: any = await h.read.getPrice([1]);
        assert.notEqual(got.timestamp, 0n);
    });
});

describe("PythLazerCache._writeFeeds — multi-feed", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    const FACTORY = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const STALENESS = 30n;

    async function deployHarness() {
        return await viem.deployContract("PythLazerCacheHarness", [
            FACTORY,
            STALENESS,
        ]);
    }

    it("stores all feeds in a multi-feed envelope", async function () {
        const h = await deployHarness();
        const feeds = [
            { feed_id: 1, price: 100n, conf: 0n, expo: -8 },
            { feed_id: 2, price: 200n, conf: 0n, expo: -8 },
            { feed_id: 3, price: 300n, conf: 0n, expo: -8 },
        ];
        await h.write.writeFeedsExt([feeds]);
        const a: any = await h.read.getPrice([1]);
        const b: any = await h.read.getPrice([2]);
        const c: any = await h.read.getPrice([3]);
        assert.equal(a.answer, 100n);
        assert.equal(b.answer, 200n);
        assert.equal(c.answer, 300n);
    });

    it("all feeds share the same timestamp (atomic write)", async function () {
        const h = await deployHarness();
        const feeds = [
            { feed_id: 1, price: 100n, conf: 0n, expo: -8 },
            { feed_id: 2, price: 200n, conf: 0n, expo: -8 },
        ];
        await h.write.writeFeedsExt([feeds]);
        const a: any = await h.read.getPrice([1]);
        const b: any = await h.read.getPrice([2]);
        assert.equal(a.timestamp, b.timestamp);
    });
});

describe("PythLazerCache._writeFeeds — monotonic roundId", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    const FACTORY = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const STALENESS = 30n;

    it("increments roundId on each write to the same feed", async function () {
        const h = await viem.deployContract("PythLazerCacheHarness", [
            FACTORY,
            STALENESS,
        ]);
        const feeds = [{ feed_id: 1, price: 100n, conf: 0n, expo: -8 }];

        await h.write.writeFeedsExt([feeds]);
        const r1: any = await h.read.getPrice([1]);
        assert.equal(r1.roundId, 1n);

        await h.write.writeFeedsExt([feeds]);
        const r2: any = await h.read.getPrice([1]);
        assert.equal(r2.roundId, 2n);

        await h.write.writeFeedsExt([feeds]);
        const r3: any = await h.read.getPrice([1]);
        assert.equal(r3.roundId, 3n);
    });

    it("tracks roundId independently per feed", async function () {
        const h = await viem.deployContract("PythLazerCacheHarness", [
            FACTORY,
            STALENESS,
        ]);
        // Refresh feed 1 twice
        await h.write.writeFeedsExt([[{ feed_id: 1, price: 100n, conf: 0n, expo: -8 }]]);
        await h.write.writeFeedsExt([[{ feed_id: 1, price: 100n, conf: 0n, expo: -8 }]]);
        // Refresh feed 2 once
        await h.write.writeFeedsExt([[{ feed_id: 2, price: 200n, conf: 0n, expo: -8 }]]);

        const r1: any = await h.read.getPrice([1]);
        const r2: any = await h.read.getPrice([2]);
        assert.equal(r1.roundId, 2n);
        assert.equal(r2.roundId, 1n);
    });
});

describe("PythLazerCache._writeFeeds — events", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    const FACTORY = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const STALENESS = 30n;

    it("emits PriceUpdated once per feed in the envelope", async function () {
        const h = await viem.deployContract("PythLazerCacheHarness", [
            FACTORY,
            STALENESS,
        ]);
        const feeds = [
            { feed_id: 1, price: 100n, conf: 0n, expo: -8 },
            { feed_id: 2, price: 200n, conf: 0n, expo: -8 },
        ];
        await h.write.writeFeedsExt([feeds]);
        const events = await h.getEvents.PriceUpdated();
        assert.equal(events.length, 2);
        // Verify feed_id indexed correctly
        const feedIds = events.map((e: any) => e.args.feedId).sort();
        assert.deepEqual(feedIds, [1, 2]);
    });

    it("PriceUpdated carries normalized answer + confidence", async function () {
        const h = await viem.deployContract("PythLazerCacheHarness", [
            FACTORY,
            STALENESS,
        ]);
        const feeds = [
            { feed_id: 99, price: 5_000_000_000_000n, conf: 50_000_000n, expo: -8 },
        ];
        await h.write.writeFeedsExt([feeds]);
        const events = await h.getEvents.PriceUpdated();
        assert.equal(events.length, 1);
        assert.equal(events[0].args.feedId, 99);
        assert.equal(events[0].args.answer, 5_000_000_000_000n);
        assert.equal(events[0].args.confidence, 50_000_000n);
    });
});
