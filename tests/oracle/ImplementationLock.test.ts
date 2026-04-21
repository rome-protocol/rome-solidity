import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/// Verifies implementation contracts are locked from direct `initialize()`
/// calls. Bare implementations (pointed to by `pythImplementation` /
/// `switchboardImplementation` in the factory) must not be callable — any
/// attacker-controlled initialization of the implementation itself must
/// revert with `AlreadyInitialized`.
describe("ImplementationLock", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    const ACCT = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const DESC = "TEST";
    const FACTORY = "0x1234567890123456789012345678901234567890" as `0x${string}`;

    function expectAlreadyInitialized(err: any): boolean {
        return err?.message?.includes("AlreadyInitialized") ?? false;
    }

    it("PythPullAdapter implementation reverts initialize() on freshly deployed contract", async function () {
        const impl = await viem.deployContract("PythPullAdapter", []);
        await assert.rejects(
            async () => impl.write.initialize([ACCT, DESC, 60n, FACTORY]),
            expectAlreadyInitialized,
        );
    });

    it("SwitchboardV3Adapter implementation reverts initialize() on freshly deployed contract", async function () {
        const impl = await viem.deployContract("SwitchboardV3Adapter", []);
        await assert.rejects(
            async () => impl.write.initialize([ACCT, DESC, 60n, FACTORY]),
            expectAlreadyInitialized,
        );
    });
});
