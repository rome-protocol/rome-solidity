import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * PythLazerCache unit tests.
 *
 * The cache is the singleton storage for Pyth Lazer prices on each Rome chain.
 * Adapters (PythLazerFeedAdapter clones) read from this cache; the foundation
 * keeper writes to it via `refresh(envelope, ix_idx, sig_idx)`.
 *
 * Spec: rome-specs/active/technical/2026-05-20-og-v2-pyth-lazer-adapter.md §3.2
 *
 * Test plan (TDD — add one test at a time, implement to pass):
 *  - Constructor: sets `maxStaleness` to the value passed in
 *  - Constructor: rejects `maxStaleness < 1` and `> 24h`
 *  - Constructor: records the factory address
 *  - getPrice(feedId): returns zero struct for unwritten feeds (cold-start)
 *  - setMaxStaleness: owner can update; emits MaxStalenessUpdated
 *  - setMaxStaleness: non-owner reverts
 *  - setMaxStaleness: rejects out-of-range
 *  - _normalize: harness-exposed; 8-decimal normalization across +/- exponents
 *  - refresh: writes prices on harness-mocked lazer_price return; emits PriceUpdated
 *  - refresh: monotonic roundId per feed
 *
 * This file starts with ONE test; the rest are TBD as we cycle through TDD.
 */
describe("PythLazerCache — constructor", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    const FACTORY = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const INIT_STALENESS = 30n; // 30 seconds — the recommended chain-wide default

    it("stores the initial maxStaleness", async function () {
        const cache = await viem.deployContract("PythLazerCache", [
            FACTORY,
            INIT_STALENESS,
        ]);
        const got: bigint = await cache.read.maxStaleness();
        assert.equal(got, INIT_STALENESS);
    });

    it("stores the factory address", async function () {
        const cache = await viem.deployContract("PythLazerCache", [
            FACTORY,
            INIT_STALENESS,
        ]);
        const got: string = await cache.read.factory();
        assert.equal(got.toLowerCase(), FACTORY.toLowerCase());
    });

    it("reverts when maxStaleness is 0", async function () {
        await assert.rejects(
            async () =>
                viem.deployContract("PythLazerCache", [FACTORY, 0n]),
            (err: any) => err?.message?.includes("StalenessOutOfRange") ?? false,
        );
    });

    it("reverts when maxStaleness exceeds 24 hours", async function () {
        const over24h = 24n * 60n * 60n + 1n;
        await assert.rejects(
            async () =>
                viem.deployContract("PythLazerCache", [FACTORY, over24h]),
            (err: any) => err?.message?.includes("StalenessOutOfRange") ?? false,
        );
    });

    it("accepts maxStaleness at the 24h boundary", async function () {
        const exact24h = 24n * 60n * 60n;
        const cache = await viem.deployContract("PythLazerCache", [
            FACTORY,
            exact24h,
        ]);
        const got: bigint = await cache.read.maxStaleness();
        assert.equal(got, exact24h);
    });
});

describe("PythLazerCache — getPrice (cold-start)", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    const FACTORY = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const INIT_STALENESS = 30n;
    const UNWRITTEN_FEED_ID = 99999;

    it("returns zero struct for an unwritten feed", async function () {
        const cache = await viem.deployContract("PythLazerCache", [
            FACTORY,
            INIT_STALENESS,
        ]);
        const price: any = await cache.read.getPrice([UNWRITTEN_FEED_ID]);
        assert.equal(price.answer, 0n);
        assert.equal(price.confidence, 0n);
        assert.equal(price.timestamp, 0n);
        assert.equal(price.roundId, 0n);
    });
});
