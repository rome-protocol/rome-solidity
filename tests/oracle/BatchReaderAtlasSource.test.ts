import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

// OracleSource.Atlas (value 2) is the plain-EVM source. A BatchReader built from
// this source decodes it; one built before the value existed reverts the whole
// getFeedHealth batch on such an adapter (an unknown enum value is a decode
// failure that try/catch does not catch).
describe("BatchReader.getFeedHealth over an Atlas-source adapter", function () {
    const SRC_ATLAS = 2;
    let viem: any;
    let publicClient: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        publicClient = await viem.getPublicClient();
    });

    async function now(): Promise<bigint> {
        const block = await publicClient.getBlock();
        return block.timestamp;
    }

    it("reports sourceType 2 from metadata()", async function () {
        const adapter = await viem.deployContract("AtlasSourceAdapterHarness", [300_00000000n, await now(), 600n]);
        const m: any = await adapter.read.metadata();
        assert.equal(Number(m.sourceType), SRC_ATLAS);
    });

    it("returns a healthy entry for a fresh Atlas adapter", async function () {
        const t = await now();
        const adapter = await viem.deployContract("AtlasSourceAdapterHarness", [300_00000000n, t, 600n]);
        const br = await viem.deployContract("BatchReader", []);
        const [h]: any = await br.read.getFeedHealth([[adapter.address]]);
        assert.equal(h.isHealthy, true);
        assert.equal(h.isPaused, false);
        assert.equal(h.isStale, false);
        assert.equal(h.latestPrice, 300_00000000n);
        assert.equal(h.lastUpdate, t);
    });

    it("reports a paused Atlas adapter unhealthy without reverting the batch", async function () {
        const t = await now();
        const good = await viem.deployContract("AtlasSourceAdapterHarness", [300_00000000n, t, 600n]);
        const paused = await viem.deployContract("AtlasSourceAdapterHarness", [300_00000000n, t, 600n]);
        await paused.write.set([300_00000000n, t, true, false]);
        const br = await viem.deployContract("BatchReader", []);
        const res: any = await br.read.getFeedHealth([[good.address, paused.address]]);
        assert.equal(res.length, 2);
        assert.equal(res[0].isHealthy, true);
        assert.equal(res[1].isHealthy, false);
        assert.equal(res[1].isPaused, true);
    });

    it("isolates a reverting Atlas adapter from the rest of the batch", async function () {
        const t = await now();
        const good = await viem.deployContract("AtlasSourceAdapterHarness", [300_00000000n, t, 600n]);
        const bad = await viem.deployContract("AtlasSourceAdapterHarness", [300_00000000n, t, 600n]);
        await bad.write.set([300_00000000n, t, false, true]);
        const br = await viem.deployContract("BatchReader", []);
        const res: any = await br.read.getFeedHealth([[bad.address, good.address]]);
        assert.equal(res[0].isHealthy, false);
        assert.equal(res[1].isHealthy, true);
    });
});
