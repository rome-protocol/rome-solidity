import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { network } from "hardhat";

// The wrappers report what actually arrived. Two things make that necessary
// rather than stylistic: SPL caps the fee at maximum_fee, so a bps computation
// is wrong above the cap; and a self-transfer nets MINUS the fee, so the naive
// direction underflows and would revert.

describe("delivered amount", async () => {
    const { viem } = await network.connect();
    const h = await viem.deployContract("DeliveredAmountHelperHarness");

    it("no armed fee: delivered is exactly what was requested", async () => {
        assert.equal(await h.read.delivered([false, false, 1000n, 0n, 0n]), 1000n);
    });

    it("armed fee: delivered is the measured credit, not the request", async () => {
        // 100 bps on 1000 → 990 credited.
        assert.equal(await h.read.delivered([true, false, 1000n, 500n, 1490n]), 990n);
    });

    it("self-transfer measures the loss, because the balance nets minus the fee", async () => {
        // Holder had 5000, sends 1000 to itself at 100 bps → nets 4990.
        // The naive direction (after - before) would underflow and revert.
        assert.equal(await h.read.delivered([true, true, 1000n, 5000n, 4990n]), 990n);
    });

    it("the fee cap is why the wrappers measure instead of computing", async () => {
        // Uncapped, bps and measurement agree.
        assert.equal(await h.read.spl_fee([1000n, 100, 1_000_000n]), 10n);
        // Capped, a bps computation over-reports the fee — so it would
        // under-report the delivered amount. Measurement is unaffected.
        assert.equal(await h.read.spl_fee([1_000_000n, 100, 50n]), 50n);
    });

    it("neither wrapper computes a fee in Solidity", () => {
        for (const f of ["erc20spl.sol", "erc20spl_cached.sol"]) {
            const s = readFileSync(`contracts/erc20spl/${f}`, "utf8");
            assert.doesNotMatch(s, /10_?000/, `${f} must not carry SPL's bps arithmetic`);
            assert.match(s, /feeBps > 0/, `${f} must use feeBps as a predicate`);
        }
    });
});
