import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

describe("AdapterMetadata", function () {
    const SRC_PYTH = 0;
    const SRC_SWITCHBOARD = 1;

    let viem: any;
    let factoryAddress: `0x${string}`;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;

        // Deploy a real OracleAdapterFactory so adapter.metadata() can resolve
        // the live paused lookup (which calls IAdapterFactory(factory).isPaused).
        // Impl / programId placeholders are fine — the factory's isPaused()
        // just reads a mapping and returns false for any unpaused adapter.
        const factory = await viem.deployContract("OracleAdapterFactory", [
            "0x0000000000000000000000000000000000000001" as `0x${string}`, // pythImpl placeholder
            "0x0000000000000000000000000000000000000002" as `0x${string}`, // switchboardImpl placeholder
            ("0x" + "00".repeat(31) + "03") as `0x${string}`,              // pythReceiverProgramId placeholder
            ("0x" + "00".repeat(31) + "04") as `0x${string}`,              // switchboardProgramId placeholder
            60n,                                                            // defaultMaxStaleness
        ]);
        factoryAddress = factory.address;
    });

    describe("PythPullAdapter.metadata()", function () {
        it("returns the values passed at initialize", async function () {
            const adapter = await viem.deployContract("PythPullAdapter", []);

            const account = ("0x" + "ab".repeat(32)) as `0x${string}`;
            const description = "SOL / USD";
            const maxStaleness = 60n;

            await adapter.write.initialize([account, description, maxStaleness, factoryAddress]);

            const m: any = await adapter.read.metadata();
            assert.equal(m.description, description);
            assert.equal(Number(m.sourceType), SRC_PYTH);
            assert.equal((m.solanaAccount as string).toLowerCase(), account.toLowerCase());
            assert.equal(m.maxStaleness, maxStaleness);
            assert.equal((m.factory as string).toLowerCase(), factoryAddress.toLowerCase());
            assert.equal(m.paused, false);
            assert.ok(m.createdAt > 0n);
        });
    });

    describe("SwitchboardV3Adapter.metadata()", function () {
        it("returns the values passed at initialize", async function () {
            const adapter = await viem.deployContract("SwitchboardV3Adapter", []);

            const account = ("0x" + "cd".repeat(32)) as `0x${string}`;
            const description = "BTC / USD";
            const maxStaleness = 120n;

            await adapter.write.initialize([account, description, maxStaleness, factoryAddress]);

            const m: any = await adapter.read.metadata();
            assert.equal(m.description, description);
            assert.equal(Number(m.sourceType), SRC_SWITCHBOARD);
            assert.equal((m.solanaAccount as string).toLowerCase(), account.toLowerCase());
            assert.equal(m.maxStaleness, maxStaleness);
            assert.equal((m.factory as string).toLowerCase(), factoryAddress.toLowerCase());
            assert.equal(m.paused, false);
            assert.ok(m.createdAt > 0n);
        });
    });
});
