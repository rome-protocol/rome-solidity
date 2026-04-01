import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

describe("PythAggregatorV3 _normalize", function () {
    let normalizer: any;

    before(async function () {
        const { viem } = await hardhat.network.connect();
        normalizer = await viem.deployContract("NormalizerHarness", []);
    });

    // ──────────────────────────────────────────────
    // Same exponent (no scaling)
    // ──────────────────────────────────────────────

    it("no-op when expo is already -8", async function () {
        // price=6543210000000 at expo=-8 → 6543210000000 (unchanged)
        const result = await normalizer.read.normalize([
            6543210000000n,
            -8,
        ]);
        assert.equal(result, 6543210000000n);
    });

    // ──────────────────────────────────────────────
    // Scale up (multiply — fewer decimals → more)
    // ──────────────────────────────────────────────

    it("scales up from expo=-5 to -8 (multiply by 1000)", async function () {
        // price=123456 at expo=-5 → 123456 * 10^3 = 123456000
        const result = await normalizer.read.normalize([123456n, -5]);
        assert.equal(result, 123456000n);
    });

    it("scales up from expo=-2 to -8 (multiply by 10^6)", async function () {
        // price=100 at expo=-2 → 100 * 10^6 = 100000000
        // This represents $1.00 → 100000000 in 8 decimals
        const result = await normalizer.read.normalize([100n, -2]);
        assert.equal(result, 100000000n);
    });

    it("scales up from expo=0 to -8 (multiply by 10^8)", async function () {
        // price=42 at expo=0 → 42 * 10^8 = 4200000000
        const result = await normalizer.read.normalize([42n, 0]);
        assert.equal(result, 4200000000n);
    });

    it("scales up from expo=2 to -8 (multiply by 10^10)", async function () {
        // price=1 at expo=2 → 1 * 10^10 = 10000000000
        const result = await normalizer.read.normalize([1n, 2]);
        assert.equal(result, 10000000000n);
    });

    // ──────────────────────────────────────────────
    // Scale down (divide — more decimals → fewer, lossy)
    // ──────────────────────────────────────────────

    it("scales down from expo=-10 to -8 (divide by 100)", async function () {
        // price=12345678900 at expo=-10 → 12345678900 / 100 = 123456789
        const result = await normalizer.read.normalize([
            12345678900n,
            -10,
        ]);
        assert.equal(result, 123456789n);
    });

    it("scales down from expo=-12 to -8 (divide by 10^4)", async function () {
        // price=5000000000000 at expo=-12 → 5000000000000 / 10000 = 500000000
        const result = await normalizer.read.normalize([
            5000000000000n,
            -12,
        ]);
        assert.equal(result, 500000000n);
    });

    it("lossy division truncates toward zero", async function () {
        // price=999 at expo=-10 → 999 / 100 = 9 (truncated from 9.99)
        const result = await normalizer.read.normalize([999n, -10]);
        assert.equal(result, 9n);
    });

    // ──────────────────────────────────────────────
    // Edge cases
    // ──────────────────────────────────────────────

    it("handles price=1 at various exponents", async function () {
        // 1 at expo=-8 = 1 (0.00000001 in 8 decimals)
        assert.equal(
            await normalizer.read.normalize([1n, -8]),
            1n,
        );
        // 1 at expo=0 = 100000000 ($1 in 8 decimals)
        assert.equal(
            await normalizer.read.normalize([1n, 0]),
            100000000n,
        );
    });

    it("handles negative price (parser allows, adapter would revert)", async function () {
        const result = await normalizer.read.normalize([-500n, -5]);
        assert.equal(result, -500000n);
    });
});
