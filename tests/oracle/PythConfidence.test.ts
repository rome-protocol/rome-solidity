import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/// Verifies H-3: PythPullAdapter.latestRoundData must reject updates whose
/// confidence interval exceeds MAX_CONF_BPS of the price (Pyth's canonical
/// consumer guidance). The check lives in the Chainlink-compat path; the
/// raw `latestPriceData()` surface continues to return unchecked conf.
describe("PythConfidence", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    const ACCT = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const DESC = "TEST";
    const FACTORY = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const MAX_STALENESS = 60n;

    async function deployHarness() {
        const h = await viem.deployContract("PythConfidenceHarness", []);
        await h.write.initialize([
            ACCT,
            DESC,
            MAX_STALENESS,
            FACTORY,
            ("0x" + "bb".repeat(32)) as `0x${string}`,
        ]);
        return h;
    }

    it("MAX_CONF_BPS is 200 (2%)", async function () {
        const h = await deployHarness();
        const max = await h.read.MAX_CONF_BPS();
        assert.equal(max, 200n);
    });

    it("passes when conf is exactly at the 2% threshold", async function () {
        const h = await deployHarness();
        // price = 100_000_000 (= $1.00 at expo=-8)
        // threshold = price * 200 / 10000 = 2_000_000
        await h.read.checkConfidenceExt([100_000_000n, 2_000_000n]);
    });

    it("reverts with ConfidenceExceedsThreshold when conf is 1 above the threshold", async function () {
        const h = await deployHarness();
        await assert.rejects(
            async () => h.read.checkConfidenceExt([100_000_000n, 2_000_001n]),
            (err: any) => err?.message?.includes("ConfidenceExceedsThreshold") ?? false,
        );
    });

    it("passes for a legitimate low-conf price (0.05%)", async function () {
        const h = await deployHarness();
        // 50_000 / 100_000_000 = 0.0005 = 5 bps ≤ 200 bps
        await h.read.checkConfidenceExt([100_000_000n, 50_000n]);
    });

    it("passes for conf = 0 (perfect signal)", async function () {
        const h = await deployHarness();
        await h.read.checkConfidenceExt([100_000_000n, 0n]);
    });

    // H-3 quality note: `_checkConfidence` is exposed via the harness
    // as `checkConfidenceExt`, so the function's safety contract must
    // hold even when called with price <= 0 directly (not just via
    // `latestRoundData`, which calls NonPositivePrice first). Without
    // the explicit guard, `uint64(price)` silently wraps a negative
    // int64 to a huge unsigned value and the conf comparison passes.
    it("reverts with NonPositivePrice when price == 0", async function () {
        const h = await deployHarness();
        await assert.rejects(
            async () => h.read.checkConfidenceExt([0n, 0n]),
            (err: any) => err?.message?.includes("NonPositivePrice") ?? false,
        );
    });

    it("reverts with NonPositivePrice when price == -1", async function () {
        const h = await deployHarness();
        await assert.rejects(
            async () => h.read.checkConfidenceExt([-1n, 0n]),
            (err: any) => err?.message?.includes("NonPositivePrice") ?? false,
        );
    });

    it("reverts with NonPositivePrice when price is negative and conf would otherwise pass", async function () {
        const h = await deployHarness();
        // Without the guard, `uint64(-1)` == 2^64 - 1, so a tiny conf would
        // pass the `conf * 10_000 > uint64(price) * 200` comparison. Assert
        // we reject on price <= 0 up front instead.
        await assert.rejects(
            async () => h.read.checkConfidenceExt([-1_000_000_000n, 100n]),
            (err: any) => err?.message?.includes("NonPositivePrice") ?? false,
        );
    });
});
