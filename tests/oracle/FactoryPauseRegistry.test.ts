import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/// Verifies H-4: factory-owner pause/unpause ops must target only registered
/// adapters. The registry prevents typos from marking arbitrary addresses
/// as "paused" and keeps emitted events auditable.
describe("OracleAdapterFactory pause registry", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    async function deployFactory() {
        const pyth = await viem.deployContract("PythPullAdapter", []);
        const sb = await viem.deployContract("SwitchboardV3Adapter", []);
        return await viem.deployContract("OracleAdapterFactory", [
            pyth.address,
            sb.address,
            ("0x" + "00".repeat(32)) as `0x${string}`,
            ("0x" + "01".repeat(32)) as `0x${string}`,
            60n,
        ]);
    }

    function expectAdapterNotRegistered(err: any): boolean {
        return err?.message?.includes("AdapterNotRegistered") ?? false;
    }

    it("pauseAdapter reverts for an unregistered address", async function () {
        const factory = await deployFactory();
        const rando = "0x000000000000000000000000000000000000cafe" as `0x${string}`;
        await assert.rejects(
            async () => factory.write.pauseAdapter([rando]),
            expectAdapterNotRegistered,
        );
    });

    it("unpauseAdapter reverts for an unregistered address", async function () {
        const factory = await deployFactory();
        const rando = "0x000000000000000000000000000000000000cafe" as `0x${string}`;
        await assert.rejects(
            async () => factory.write.unpauseAdapter([rando]),
            expectAdapterNotRegistered,
        );
    });

    it("isRegisteredAdapter returns false for a fresh EOA", async function () {
        const factory = await deployFactory();
        const rando = "0x000000000000000000000000000000000000cafe" as `0x${string}`;
        const reg = (await factory.read.isRegisteredAdapter([rando])) as boolean;
        assert.equal(reg, false);
    });

    // Note: pause/unpause on a genuinely-registered adapter cannot be tested
    // without going through `createPythFeed` / `createSwitchboardFeed`, both
    // of which call the CPI precompile (unavailable on hardhat's simulated
    // network). The successful path is exercised end-to-end on live networks
    // via scripts/oracle/test-feeds-v2.ts. The registry gate itself — which is
    // the entire point of H-4 — is covered here.
});
