import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/// Unit tests for OracleAdapterFactory ownership transfer guardrails.
describe("OracleAdapterFactory.transferOwnership", function () {
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

    it("reverts when transferring ownership to the zero address", async function () {
        const factory = await deployFactory();
        await assert.rejects(
            async () =>
                factory.write.transferOwnership([
                    "0x0000000000000000000000000000000000000000" as `0x${string}`,
                ]),
            (err: any) => err?.message?.includes("ZeroAddress") ?? false,
        );
    });

    it("allows transferring ownership to a non-zero address", async function () {
        const factory = await deployFactory();
        const newOwner = "0x1234567890123456789012345678901234567890" as `0x${string}`;
        await factory.write.transferOwnership([newOwner]);
        const current = (await factory.read.owner()) as string;
        assert.equal(current.toLowerCase(), newOwner.toLowerCase());
    });
});
