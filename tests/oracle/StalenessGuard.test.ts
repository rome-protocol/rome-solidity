import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

describe("StalenessGuard", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    const ACCT = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const DESC = "TEST";
    const FACTORY = "0x1234567890123456789012345678901234567890" as `0x${string}`;

    async function deployAdapter() {
        return await viem.deployContract("PythPullAdapter", []);
    }

    async function deployFactory(defaultStaleness: bigint) {
        const pyth = await viem.deployContract("PythPullAdapter", []);
        const sb = await viem.deployContract("SwitchboardV3Adapter", []);
        return await viem.deployContract("OracleAdapterFactory", [
            pyth.address,
            sb.address,
            ("0x" + "00".repeat(32)) as `0x${string}`,
            ("0x" + "01".repeat(32)) as `0x${string}`,
            defaultStaleness,
        ]);
    }

    function expectStalenessOutOfRange(err: any): boolean {
        return err?.message?.includes("StalenessOutOfRange") ?? false;
    }

    describe("PythPullAdapter.initialize", function () {
        it("rejects staleness = 0", async function () {
            const a = await deployAdapter();
            await assert.rejects(
                async () => a.write.initialize([ACCT, DESC, 0n, FACTORY]),
                expectStalenessOutOfRange,
            );
        });

        it("rejects staleness > 24 hours", async function () {
            const a = await deployAdapter();
            const TOO_LONG = 24n * 60n * 60n + 1n;
            await assert.rejects(
                async () => a.write.initialize([ACCT, DESC, TOO_LONG, FACTORY]),
                expectStalenessOutOfRange,
            );
        });

        it("accepts staleness = 1", async function () {
            const a = await deployAdapter();
            await a.write.initialize([ACCT, DESC, 1n, FACTORY]);
        });

        it("accepts staleness = 24 hours (86400)", async function () {
            const a = await deployAdapter();
            await a.write.initialize([ACCT, DESC, 86400n, FACTORY]);
        });

        it("accepts staleness = 60", async function () {
            const a = await deployAdapter();
            await a.write.initialize([ACCT, DESC, 60n, FACTORY]);
        });
    });

    describe("OracleAdapterFactory", function () {
        it("rejects constructor with defaultMaxStaleness = 0", async function () {
            await assert.rejects(
                async () => deployFactory(0n),
                expectStalenessOutOfRange,
            );
        });

        it("rejects constructor with defaultMaxStaleness > 24h", async function () {
            await assert.rejects(
                async () => deployFactory(86401n),
                expectStalenessOutOfRange,
            );
        });

        it("rejects setDefaultMaxStaleness(0)", async function () {
            const factory = await deployFactory(60n);
            await assert.rejects(
                async () => factory.write.setDefaultMaxStaleness([0n]),
                expectStalenessOutOfRange,
            );
        });

        it("rejects setDefaultMaxStaleness(> 24h)", async function () {
            const factory = await deployFactory(60n);
            await assert.rejects(
                async () => factory.write.setDefaultMaxStaleness([86401n]),
                expectStalenessOutOfRange,
            );
        });

        it("accepts setDefaultMaxStaleness(86400)", async function () {
            const factory = await deployFactory(60n);
            await factory.write.setDefaultMaxStaleness([86400n]);
        });
    });
});
