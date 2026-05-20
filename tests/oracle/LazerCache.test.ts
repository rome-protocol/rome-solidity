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
});
