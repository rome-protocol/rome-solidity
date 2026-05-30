import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/**
 * OG-V2 first-class wiring for the two cached adapters:
 *  - CachedPythAdapter (Pyth-specific, re-parses the Pyth account) via createCachedPythFeed
 *  - CachedFeedAdapter (generic, wraps any AggregatorV3) via createCachedFeed
 *
 * createCachedPythFeed's happy path calls the CPI account_info precompile
 * (unavailable on hardhat) so it is verified live via test-feeds-v2.ts; here we
 * cover its precompile-free surface. createCachedFeed takes an EVM underlying
 * (no Solana account validation) so its FULL create path is unit-tested here.
 */
const ZERO = "0x0000000000000000000000000000000000000000";

describe("OracleAdapterFactory cached adapters", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    async function deployFactory() {
        const pyth = await viem.deployContract("PythPullAdapter", []);
        const sb = await viem.deployContract("SwitchboardV3Adapter", []);
        const cachedPyth = await viem.deployContract("CachedPythAdapter", []);
        const cachedFeed = await viem.deployContract("CachedFeedAdapter", []);
        const factory = await viem.deployContract("OracleAdapterFactory", [
            pyth.address,
            sb.address,
            ("0x" + "00".repeat(32)) as `0x${string}`,
            ("0x" + "01".repeat(32)) as `0x${string}`,
            60n,
            cachedPyth.address,
            cachedFeed.address,
        ]);
        return { factory, cachedPyth, cachedFeed };
    }

    async function deployMock() {
        return await viem.deployContract("MockAggregatorV3", [300000000000n, 1000000000n, 8]);
    }

    it("stores cachedPythImplementation + cachedFeedImplementation from the constructor", async function () {
        const { factory, cachedPyth, cachedFeed } = await deployFactory();
        assert.equal(((await factory.read.cachedPythImplementation()) as string).toLowerCase(), cachedPyth.address.toLowerCase());
        assert.equal(((await factory.read.cachedFeedImplementation()) as string).toLowerCase(), cachedFeed.address.toLowerCase());
    });

    it("cachedPythAdapters mapping starts empty for an unseen pubkey", async function () {
        const { factory } = await deployFactory();
        const a = (await factory.read.cachedPythAdapters([("0x" + "ab".repeat(32)) as `0x${string}`])) as string;
        assert.equal(a, ZERO);
    });

    it("createCachedFeed deploys + registers a cache wrapping the underlying", async function () {
        const { factory } = await deployFactory();
        const mock = await deployMock();
        await factory.write.createCachedFeed([mock.address, "ETH / USD", 60n]);
        const adapter = (await factory.read.cachedFeedAdapters([mock.address])) as string;
        assert.notEqual(adapter, ZERO, "adapter should be registered for the underlying");
        assert.equal((await factory.read.isRegisteredAdapter([adapter])) as boolean, true);
        const cf = await viem.getContractAt("CachedFeedAdapter", adapter as `0x${string}`);
        assert.equal(((await cf.read.underlying()) as string).toLowerCase(), mock.address.toLowerCase());
        assert.equal(await cf.read.decimals(), 8, "decimals snapshotted from underlying");
    });

    it("createCachedFeed reverts FeedAlreadyExists for a duplicate underlying", async function () {
        const { factory } = await deployFactory();
        const mock = await deployMock();
        await factory.write.createCachedFeed([mock.address, "ETH / USD", 60n]);
        await assert.rejects(
            async () => factory.write.createCachedFeed([mock.address, "ETH / USD", 60n]),
            (e: any) => e.message.includes("FeedAlreadyExists"),
        );
    });
});
