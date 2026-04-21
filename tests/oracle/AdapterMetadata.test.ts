import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

describe("AdapterMetadata", function () {
    const SRC_PYTH = 0;
    const SRC_SWITCHBOARD = 1;

    let viem: any;
    let cloneHelper: any;
    let pythImplAddr: `0x${string}`;
    let sbImplAddr: `0x${string}`;
    let factoryAddress: `0x${string}`;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;

        cloneHelper = await viem.deployContract("AdapterCloneFactory", []);
        const pythImpl = await viem.deployContract("PythPullAdapter", []);
        const sbImpl = await viem.deployContract("SwitchboardV3Adapter", []);
        pythImplAddr = pythImpl.address;
        sbImplAddr = sbImpl.address;

        // Deploy a real OracleAdapterFactory so adapter.metadata() can resolve
        // the live paused lookup (which calls IAdapterFactory(factory).isPaused).
        // Impl / programId placeholders are fine — the factory's isPaused()
        // just reads a mapping and returns false for any unpaused adapter.
        const factory = await viem.deployContract("OracleAdapterFactory", [
            pythImplAddr,
            sbImplAddr,
            ("0x" + "00".repeat(31) + "03") as `0x${string}`,              // pythReceiverProgramId placeholder
            ("0x" + "00".repeat(31) + "04") as `0x${string}`,              // switchboardProgramId placeholder
            60n,                                                            // defaultMaxStaleness
        ]);
        factoryAddress = factory.address;
    });

    // Deploy an EIP-1167 clone of an implementation. The implementation
    // contracts are locked from direct initialize() (C-1), so metadata
    // tests must run against a clone.
    async function cloneOf(impl: `0x${string}`, contractName: string) {
        const publicClient = await viem.getPublicClient();
        const hash = await cloneHelper.write.cloneOf([impl]);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        const topic = receipt.logs[0].topics[2] as `0x${string}`;
        const cloneAddr = ("0x" + topic.slice(-40)) as `0x${string}`;
        return await viem.getContractAt(contractName, cloneAddr);
    }

    describe("PythPullAdapter.metadata()", function () {
        it("returns the values passed at initialize", async function () {
            const adapter = await cloneOf(pythImplAddr, "PythPullAdapter");

            const account = ("0x" + "ab".repeat(32)) as `0x${string}`;
            const description = "SOL / USD";
            const maxStaleness = 60n;

            await adapter.write.initialize([
                account,
                description,
                maxStaleness,
                factoryAddress,
                ("0x" + "77".repeat(32)) as `0x${string}`,
            ]);

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
            const adapter = await cloneOf(sbImplAddr, "SwitchboardV3Adapter");

            const account = ("0x" + "cd".repeat(32)) as `0x${string}`;
            const description = "BTC / USD";
            const maxStaleness = 120n;

            await adapter.write.initialize([
                account,
                description,
                maxStaleness,
                factoryAddress,
                ("0x" + "88".repeat(32)) as `0x${string}`,
            ]);

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
