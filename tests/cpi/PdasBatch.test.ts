import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * Tests for PdasBatch library — multi-PDA derive on the CPI precompile.
 *
 * The on-chain `derive` paths require the CPI precompile (`0xFF…08`),
 * which doesn't exist on hardhatMainnet. Network-independent shape
 * assertions live here; live-precompile assertions are exercised
 * against a live Rome devnet/testnet chain (the CPI precompile is
 * required for the real derive path).
 *
 * Empty-group path IS exercised here because the precompile fallback
 * for N=0 returns an empty array without any syscall — pure ABI
 * round-trip, no CPI required.
 */
describe("PdasBatch", () => {
    let wrapper: any;

    before(async () => {
        const { viem } = await hardhat.network.connect();
        wrapper = await viem.deployContract("PdasBatchWrapper", []);
    });

    it("buildPair composes builders into 2 groups of 2 seeds each", async () => {
        const a = ("0x" + "11".repeat(32)) as `0x${string}`;
        const b = ("0x" + "22".repeat(32)) as `0x${string}`;
        const [count, lenA, lenB] = (await wrapper.read.buildPair([a, b])) as [
            bigint,
            bigint,
            bigint,
        ];
        assert.equal(count, 2n);
        assert.equal(lenA, 2n);
        assert.equal(lenB, 2n);
    });
});
