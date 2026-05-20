import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * PythLazerCache._normalize unit tests via PythLazerCacheHarness.
 *
 * Lazer's wire format carries `price: int64` with negative `expo: int16`
 * (e.g. -8 for USD-priced crypto, -2 for FX percentages). The cache
 * normalizes both `answer` and `confidence` to 8 decimals at write time
 * — mirrors PythPullAdapter._normalize at PythPullAdapter.sol:258-270.
 *
 * Reading at 8 decimals is the Chainlink convention; Comet enforces
 * `priceFeed.decimals() == PRICE_FEED_DECIMALS == 8` at constructor +
 * per-asset-add (Comet.sol:156, 243). Diverging breaks consumer drop-in.
 *
 * Math:
 *   expo == -8  →  return price (no change)
 *   expo <  -8  →  divide by 10^(-8 - expo)   (raw has MORE decimals than target)
 *   expo >  -8  →  multiply by 10^(expo + 8)  (raw has FEWER decimals than target)
 *
 * Spec: rome-specs/active/technical/2026-05-20-og-v2-pyth-lazer-adapter.md §3.2
 */
describe("PythLazerCache._normalize", function () {
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

    it("returns price unchanged at expo == -8", async function () {
        const h = await deployHarness();
        // BTC at $50,000 with expo -8 = 50_000 * 1e8 = 5_000_000_000_000
        const got: bigint = await h.read.normalize([
            5_000_000_000_000n,
            -8,
        ]);
        assert.equal(got, 5_000_000_000_000n);
    });

    it("divides when expo < -8 (raw has more decimals)", async function () {
        const h = await deployHarness();
        // funding rate at expo -12: raw 1_234_567_890_000_000 → expected /10000 = 123_456_789_000
        const got: bigint = await h.read.normalize([
            1_234_567_890_000_000n,
            -12,
        ]);
        assert.equal(got, 123_456_789_000n);
    });

    it("multiplies when expo > -8 (raw has fewer decimals)", async function () {
        const h = await deployHarness();
        // ratio at expo -2: raw 42 → expected *1e6 = 42_000_000
        const got: bigint = await h.read.normalize([42n, -2]);
        assert.equal(got, 42_000_000n);
    });

    it("normalizes negative prices correctly (signed)", async function () {
        const h = await deployHarness();
        // Hypothetical negative-price feed at expo -8
        const got: bigint = await h.read.normalize([-1_500_000_000n, -8]);
        assert.equal(got, -1_500_000_000n);
    });

    it("handles expo == 0 (multiply by 1e8)", async function () {
        const h = await deployHarness();
        const got: bigint = await h.read.normalize([7n, 0]);
        assert.equal(got, 700_000_000n);
    });

    it("handles zero price (boundary)", async function () {
        const h = await deployHarness();
        const got: bigint = await h.read.normalize([0n, -8]);
        assert.equal(got, 0n);
    });
});
