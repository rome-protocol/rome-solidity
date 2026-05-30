import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { buildPythPullAccount } from "./helpers/mockPythPull.js";

/**
 * CachedPythAdapter: refresh() reads+parses the (mocked) Solana Pyth account
 * and SSTOREs the price; latestRoundData() is a pure SLOAD of that cache.
 * The harness overrides _fetchAccount to inject mock bytes (the CPI precompile
 * is unavailable on hardhat).
 */
describe("CachedPythAdapter", function () {
    let viem: any;
    let conn: any;

    const FACTORY_NONE = "0x0000000000000000000000000000000000000000" as `0x${string}`;
    const PYTH_ACCT = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const MAX_STALENESS = 3600n; // 1 hour

    before(async function () {
        conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    async function deployHarness(maxStaleness: bigint = MAX_STALENESS) {
        const h = await viem.deployContract("CachedPythAdapterHarness", []);
        await h.write.initialize([PYTH_ACCT, "ETH / USD", maxStaleness, FACTORY_NONE]);
        return h;
    }

    async function nowTs(): Promise<number> {
        const pc = await viem.getPublicClient();
        return Number((await pc.getBlock()).timestamp);
    }

    it("reverts UninitializedPriceFeed before any refresh", async function () {
        const h = await deployHarness();
        await assert.rejects(
            async () => h.read.latestRoundData(),
            (e: any) => e.message.includes("UninitializedPriceFeed"),
        );
    });

    it("refresh() caches the parsed price; latestRoundData() SLOADs it", async function () {
        const h = await deployHarness();
        const publishTime = (await nowTs()) - 30; // fresh, in the past
        // price 3000e8, expo -8 → normalize to 8dec = 300000000000
        const bytes = buildPythPullAccount({ price: 300000000000n, conf: 0n, expo: -8, publishTime });
        await h.write.setMockData([bytes]);
        await h.write.refresh([]);

        const r = (await h.read.latestRoundData()) as readonly [bigint, bigint, bigint, bigint, bigint];
        assert.equal(r[1], 300000000000n, "answer should equal the cached normalized price");
        assert.equal(r[3], BigInt(publishTime), "updatedAt should equal cached publishTime");
        // and it's a stored value, not a re-parse: cachedAt is set
        const cachedAt = (await h.read.cachedAt()) as bigint;
        assert.ok(cachedAt > 0n, "cachedAt should be set after refresh");
    });

    it("refresh() refuses to cache an already-stale price", async function () {
        const h = await deployHarness(60n); // 60s window
        const publishTime = (await nowTs()) - 600; // 10 min old → stale
        const bytes = buildPythPullAccount({ price: 300000000000n, conf: 0n, expo: -8, publishTime });
        await h.write.setMockData([bytes]);
        await assert.rejects(
            async () => h.write.refresh([]),
            (e: any) => e.message.includes("StalePriceFeed"),
        );
    });

    it("latestRoundData() reverts StalePriceFeed once the cached price ages out", async function () {
        const h = await deployHarness(60n); // 60s window
        const publishTime = (await nowTs()) - 5; // fresh now
        const bytes = buildPythPullAccount({ price: 300000000000n, conf: 0n, expo: -8, publishTime });
        await h.write.setMockData([bytes]);
        await h.write.refresh([]); // caches OK
        // advance past the 60s window
        await conn.provider.request({ method: "evm_increaseTime", params: [120] });
        await conn.provider.request({ method: "evm_mine", params: [] });
        await assert.rejects(
            async () => h.read.latestRoundData(),
            (e: any) => e.message.includes("StalePriceFeed"),
        );
    });
});
