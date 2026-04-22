import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";

/// Verifies H-1: `_checkStaleness` must not panic with 0x11 (arithmetic
/// underflow) when `publishTime > block.timestamp`. Such clock skew is
/// real on devnet — Solana's clock can run a few seconds ahead of EVM's
/// — and the old code's `block.timestamp - publishTime` subtraction would
/// panic, which is swallowed by BatchReader's `catch{}` and indistinguishable
/// from other failure modes.
///
/// The fix reverts with `StalePriceFeed` instead, for both adapters.
describe("StalenessUnderflow", function () {
    let viem: any;
    let publicClient: any;
    const ACCT = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const DESC = "TEST";
    const FACTORY = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const MAX_STALENESS = 60n;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        publicClient = await viem.getPublicClient();
    });

    function expectStalePriceFeed(err: any): boolean {
        // panic 0x11 is the underflow — if we see it, the fix is missing.
        assert.ok(
            !(err?.message?.includes("0x11") || err?.message?.includes("underflow")),
            `Unexpected arithmetic underflow panic: ${err?.message}`,
        );
        return err?.message?.includes("StalePriceFeed") ?? false;
    }

    async function currentBlockTimestamp(): Promise<bigint> {
        const block = await publicClient.getBlock();
        return BigInt(block.timestamp);
    }

    describe("PythPullAdapter._checkStaleness", function () {
        async function deployHarness() {
            const h = await viem.deployContract("PythStalenessHarness", []);
            await h.write.initialize([
                ACCT,
                DESC,
                MAX_STALENESS,
                FACTORY,
                ("0x" + "bb".repeat(32)) as `0x${string}`,
            ]);
            return h;
        }

        it("passes when publishTime == block.timestamp", async function () {
            const h = await deployHarness();
            const ts = await currentBlockTimestamp();
            await h.read.checkStalenessExt([ts]);
        });

        it("reverts with StalePriceFeed when publishTime is one second in the future", async function () {
            const h = await deployHarness();
            const ts = await currentBlockTimestamp();
            await assert.rejects(
                async () => h.read.checkStalenessExt([ts + 1n]),
                expectStalePriceFeed,
            );
        });

        it("reverts with StalePriceFeed when publishTime is older than maxStaleness", async function () {
            const h = await deployHarness();
            const ts = await currentBlockTimestamp();
            // ts - MAX_STALENESS - 1 → strictly older than maxStaleness.
            await assert.rejects(
                async () =>
                    h.read.checkStalenessExt([ts - MAX_STALENESS - 1n]),
                expectStalePriceFeed,
            );
        });
    });

    describe("SwitchboardV3Adapter._checkStaleness", function () {
        async function deployHarness() {
            const h = await viem.deployContract("SwitchboardStalenessHarness", []);
            await h.write.initialize([
                ACCT,
                DESC,
                MAX_STALENESS,
                FACTORY,
                ("0x" + "bb".repeat(32)) as `0x${string}`,
            ]);
            return h;
        }

        it("passes when timestamp == block.timestamp", async function () {
            const h = await deployHarness();
            const ts = await currentBlockTimestamp();
            await h.read.checkStalenessExt([ts]);
        });

        it("reverts with StalePriceFeed when timestamp is one second in the future", async function () {
            const h = await deployHarness();
            const ts = await currentBlockTimestamp();
            await assert.rejects(
                async () => h.read.checkStalenessExt([ts + 1n]),
                expectStalePriceFeed,
            );
        });

        it("reverts with StalePriceFeed when timestamp is older than maxStaleness", async function () {
            const h = await deployHarness();
            const ts = await currentBlockTimestamp();
            await assert.rejects(
                async () =>
                    h.read.checkStalenessExt([ts - MAX_STALENESS - 1n]),
                expectStalePriceFeed,
            );
        });
    });
});
