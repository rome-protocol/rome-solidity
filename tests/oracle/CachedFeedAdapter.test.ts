import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * CachedFeedAdapter: a source-agnostic cache over any AggregatorV3 feed.
 * refresh() reads the (mock) underlying once and SSTOREs; latestRoundData()
 * is a pure SLOAD. No CPI precompile needed — the underlying is a plain mock
 * AggregatorV3, so the full happy path runs on hardhat's simulated network.
 */
describe("CachedFeedAdapter", function () {
    let viem: any;
    let conn: any;

    const FACTORY_NONE = "0x0000000000000000000000000000000000000000" as `0x${string}`;
    const MAX_STALENESS = 3600n;

    before(async function () {
        conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    async function nowTs(): Promise<number> {
        const pc = await viem.getPublicClient();
        return Number((await pc.getBlock()).timestamp);
    }

    async function deploy(maxStaleness: bigint = MAX_STALENESS, answer: bigint = 300000000000n, ageSec = 30, dec = 8) {
        const updatedAt = BigInt((await nowTs()) - ageSec);
        const mock = await viem.deployContract("MockAggregatorV3", [answer, updatedAt, dec]);
        const h = await viem.deployContract("CachedFeedAdapterHarness", []);
        await h.write.initialize([mock.address, "ETH / USD", maxStaleness, FACTORY_NONE]);
        return { h, mock, updatedAt };
    }

    it("reverts UninitializedPriceFeed before any refresh", async function () {
        const { h } = await deploy();
        await assert.rejects(
            async () => h.read.latestRoundData(),
            (e: any) => e.message.includes("UninitializedPriceFeed"),
        );
    });

    it("refresh() caches the underlying price; latestRoundData() SLOADs it", async function () {
        const { h, updatedAt } = await deploy();
        await h.write.refresh([]);
        const r = (await h.read.latestRoundData()) as readonly [bigint, bigint, bigint, bigint, bigint];
        assert.equal(r[1], 300000000000n, "answer should equal the cached underlying price");
        assert.equal(r[3], updatedAt, "updatedAt should equal the underlying round time");
        assert.ok(((await h.read.cachedAt()) as bigint) > 0n, "cachedAt should be set after refresh");
    });

    it("decimals() proxies the underlying", async function () {
        const { h } = await deploy(MAX_STALENESS, 300000000000n, 30, 8);
        assert.equal(await h.read.decimals(), 8);
    });

    it("refresh() refuses to cache an already-stale underlying price", async function () {
        const { h } = await deploy(60n, 300000000000n, 600); // 10 min old, 60s window
        await assert.rejects(
            async () => h.write.refresh([]),
            (e: any) => e.message.includes("StalePriceFeed"),
        );
    });

    it("latestRoundData() reverts StalePriceFeed once the cached price ages out", async function () {
        const { h } = await deploy(60n, 300000000000n, 5);
        await h.write.refresh([]);
        await conn.provider.request({ method: "evm_increaseTime", params: [120] });
        await conn.provider.request({ method: "evm_mine", params: [] });
        await assert.rejects(
            async () => h.read.latestRoundData(),
            (e: any) => e.message.includes("StalePriceFeed"),
        );
    });
});
