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
            async () => impl.write.initialize([
                ACCT,
                DESC,
                60n,
                FACTORY,
                ("0x" + "bb".repeat(32)) as `0x${string}`,
            ]),
            expectAlreadyInitialized,
        );
    });

    it("SwitchboardV3Adapter implementation reverts initialize() on freshly deployed contract", async function () {
        const impl = await viem.deployContract("SwitchboardV3Adapter", []);
        await assert.rejects(
            async () => impl.write.initialize([
                ACCT,
                DESC,
                60n,
                FACTORY,
                ("0x" + "bb".repeat(32)) as `0x${string}`,
            ]),
            expectAlreadyInitialized,
        );
    });
});

/// Verifies C-1 clone-level protection and the M-5 re-init invariant.
/// Clones deployed via `AdapterCloneFactory.cloneOf` have independent storage,
/// so the constructor-level lock on the implementation does not protect them.
/// The production guard is the `if (initialized) revert AlreadyInitialized()`
/// check inside `initialize()` itself. These tests deploy a fresh clone,
/// successfully initialize it once, and then verify that a second
/// `initialize(...)` call always reverts — even when passing different args,
/// in particular a different `expectedProgramId` (M-5 linchpin).
describe("CloneDoubleInit", function () {
    let viem: any;
    let cloneHelper: any;
    let pythImplAddr: `0x${string}`;
    let sbImplAddr: `0x${string}`;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        cloneHelper = await viem.deployContract("AdapterCloneFactory", []);
        const pythImpl = await viem.deployContract("PythPullAdapter", []);
        const sbImpl = await viem.deployContract("SwitchboardV3Adapter", []);
        pythImplAddr = pythImpl.address;
        sbImplAddr = sbImpl.address;
    });

    const ACCT = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const DESC = "TEST";
    const FACTORY = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const MAX_STALENESS = 60n;
    const PROGRAM_ID_A = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const PROGRAM_ID_B = ("0x" + "bb".repeat(32)) as `0x${string}`;

    function expectAlreadyInitialized(err: any): boolean {
        return err?.message?.includes("AlreadyInitialized") ?? false;
    }

    async function cloneOf(impl: `0x${string}`, contractName: string) {
        const publicClient = await viem.getPublicClient();
        const hash = await cloneHelper.write.cloneOf([impl]);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const topic = receipt.logs[0].topics[2] as `0x${string}`;
        const cloneAddr = ("0x" + topic.slice(-40)) as `0x${string}`;
        return await viem.getContractAt(contractName, cloneAddr);
    }

    describe("PythPullAdapter clone", function () {
        it("allows initialize() exactly once", async function () {
            const adapter = await cloneOf(pythImplAddr, "PythPullAdapter");
            await adapter.write.initialize([
                ACCT,
                DESC,
                MAX_STALENESS,
                FACTORY,
                PROGRAM_ID_A,
            ]);
            const init = (await adapter.read.initialized()) as boolean;
            assert.equal(init, true);
        });

        it("reverts a second initialize() with the same args", async function () {
            const adapter = await cloneOf(pythImplAddr, "PythPullAdapter");
            await adapter.write.initialize([
                ACCT,
                DESC,
                MAX_STALENESS,
                FACTORY,
                PROGRAM_ID_A,
            ]);
            await assert.rejects(
                async () => adapter.write.initialize([
                    ACCT,
                    DESC,
                    MAX_STALENESS,
                    FACTORY,
                    PROGRAM_ID_A,
                ]),
                expectAlreadyInitialized,
            );
        });

        // M-5 gap: expectedProgramId is the linchpin of owner re-validation.
        // Once set during initialize() it must not be overwritable by a
        // subsequent initialize() call.
        it("reverts a second initialize() with a different expectedProgramId and preserves the stored value (M-5)", async function () {
            const adapter = await cloneOf(pythImplAddr, "PythPullAdapter");
            await adapter.write.initialize([
                ACCT,
                DESC,
                MAX_STALENESS,
                FACTORY,
                PROGRAM_ID_A,
            ]);
            await assert.rejects(
                async () => adapter.write.initialize([
                    ACCT,
                    DESC,
                    MAX_STALENESS,
                    FACTORY,
                    PROGRAM_ID_B,
                ]),
                expectAlreadyInitialized,
            );
            const stored = (await adapter.read.expectedProgramId()) as string;
            assert.equal(stored.toLowerCase(), PROGRAM_ID_A.toLowerCase());
        });
    });

    describe("SwitchboardV3Adapter clone", function () {
        it("allows initialize() exactly once", async function () {
            const adapter = await cloneOf(sbImplAddr, "SwitchboardV3Adapter");
            await adapter.write.initialize([
                ACCT,
                DESC,
                MAX_STALENESS,
                FACTORY,
                PROGRAM_ID_A,
            ]);
            const init = (await adapter.read.initialized()) as boolean;
            assert.equal(init, true);
        });

        it("reverts a second initialize() with the same args", async function () {
            const adapter = await cloneOf(sbImplAddr, "SwitchboardV3Adapter");
            await adapter.write.initialize([
                ACCT,
                DESC,
                MAX_STALENESS,
                FACTORY,
                PROGRAM_ID_A,
            ]);
            await assert.rejects(
                async () => adapter.write.initialize([
                    ACCT,
                    DESC,
                    MAX_STALENESS,
                    FACTORY,
                    PROGRAM_ID_A,
                ]),
                expectAlreadyInitialized,
            );
        });

        // M-5 gap: same invariant as PythPullAdapter — expectedProgramId
        // cannot be overwritten by a second initialize().
        it("reverts a second initialize() with a different expectedProgramId and preserves the stored value (M-5)", async function () {
            const adapter = await cloneOf(sbImplAddr, "SwitchboardV3Adapter");
            await adapter.write.initialize([
                ACCT,
                DESC,
                MAX_STALENESS,
                FACTORY,
                PROGRAM_ID_A,
            ]);
            await assert.rejects(
                async () => adapter.write.initialize([
                    ACCT,
                    DESC,
                    MAX_STALENESS,
                    FACTORY,
                    PROGRAM_ID_B,
                ]),
                expectAlreadyInitialized,
            );
            const stored = (await adapter.read.expectedProgramId()) as string;
            assert.equal(stored.toLowerCase(), PROGRAM_ID_A.toLowerCase());
        });
    });
});
