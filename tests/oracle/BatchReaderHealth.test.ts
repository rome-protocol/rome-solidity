import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

describe("BatchReader.getFeedHealth", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    it("returns empty array for empty input", async function () {
        const br = await viem.deployContract("BatchReader", []);
        const results = await br.read.getFeedHealth([[]]);
        assert.equal((results as any[]).length, 0);
    });

    it("returns a FeedHealth entry per input address (all unhealthy for EOAs)", async function () {
        // EOA addresses — any calls will fail. Expect per-adapter try/catch
        // isolation: all three entries returned, all isHealthy=false.
        const br = await viem.deployContract("BatchReader", []);

        const addrs = [
            "0x1111111111111111111111111111111111111111" as `0x${string}`,
            "0x2222222222222222222222222222222222222222" as `0x${string}`,
            "0x3333333333333333333333333333333333333333" as `0x${string}`,
        ];

        const results: any = await br.read.getFeedHealth([addrs]);
        assert.equal(results.length, 3);
        assert.equal(results[0].adapter.toLowerCase(), addrs[0].toLowerCase());
        assert.equal(results[1].adapter.toLowerCase(), addrs[1].toLowerCase());
        assert.equal(results[2].adapter.toLowerCase(), addrs[2].toLowerCase());
        assert.equal(results[0].isHealthy, false);
        assert.equal(results[1].isHealthy, false);
        assert.equal(results[2].isHealthy, false);
    });

    it("isolates a failing adapter from successful adapters (batch survives)", async function () {
        // Verifies try/catch path does not cause the outer call to revert
        // even when mixed with clearly-unreachable adapters.
        const br = await viem.deployContract("BatchReader", []);

        const mix = [
            "0x4444444444444444444444444444444444444444" as `0x${string}`,
            "0x000000000000000000000000000000000000dEaD" as `0x${string}`,
            "0x5555555555555555555555555555555555555555" as `0x${string}`,
        ];

        const results: any = await br.read.getFeedHealth([mix]);
        assert.equal(results.length, 3);
        for (const r of results) {
            assert.equal(r.isHealthy, false);
        }
    });
});
