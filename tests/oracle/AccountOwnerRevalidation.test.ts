import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { buildPythPullAccount } from "./helpers/mockPythPull.js";
import { buildSwitchboardAccount } from "./helpers/mockSwitchboard.js";

/// PR6 NOTE: M-5 (per-read owner revalidation) was retired when oracle
/// adapters migrated from `account_info` to `account_data_at` for the data
/// fetch — see PythPullAdapter._fetchAccount and SwitchboardV3Adapter
/// ._fetchAccount for the security trade-off rationale. Two revert cases
/// previously in this file (one for each adapter) were removed; the
/// remaining tests verify that:
///   - `expectedProgramId` is still stored at initialize() (factory-side
///     audit trail), even though it's no longer enforced per-read
///   - The end-to-end parse path returns sane values for valid mock data
describe("AccountOwnerRevalidation", function () {
    let viem: any;

    before(async function () {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
    });

    const ACCT = ("0x" + "aa".repeat(32)) as `0x${string}`;
    const DESC = "TEST";
    const FACTORY = "0x1234567890123456789012345678901234567890" as `0x${string}`;
    const MAX_STALENESS = 60n;
    const PROGRAM_ID_A = ("0x" + "11".repeat(32)) as `0x${string}`;

    describe("PythPullAdapter", function () {
        it("stores expectedProgramId at initialize and exposes it via metadata", async function () {
            const h = await viem.deployContract("PythAccountOwnerHarness", []);
            await h.write.initialize([ACCT, DESC, MAX_STALENESS, FACTORY, PROGRAM_ID_A]);
            const stored = (await h.read.expectedProgramId()) as string;
            assert.equal(stored.toLowerCase(), PROGRAM_ID_A.toLowerCase());
        });

        it("end-to-end parses valid mock data (M-5 owner check retired)", async function () {
            const h = await viem.deployContract("PythAccountOwnerHarness", []);
            await h.write.initialize([ACCT, DESC, MAX_STALENESS, FACTORY, PROGRAM_ID_A]);

            const valid = buildPythPullAccount({
                price: 100_000_000n,
                conf: 100n,
                expo: -8,
                publishTime: 1711900800,
            });
            await h.write.setMockAccount([ACCT, PROGRAM_ID_A, valid]);

            const [, , , publishTime] = (await h.read.readAndParseExt()) as any;
            assert.equal(publishTime, 1711900800n);
        });
    });

    describe("SwitchboardV3Adapter", function () {
        it("stores expectedProgramId at initialize and exposes it via metadata", async function () {
            const h = await viem.deployContract("SwitchboardAccountOwnerHarness", []);
            await h.write.initialize([ACCT, DESC, MAX_STALENESS, FACTORY, PROGRAM_ID_A]);
            const stored = (await h.read.expectedProgramId()) as string;
            assert.equal(stored.toLowerCase(), PROGRAM_ID_A.toLowerCase());
        });

        it("end-to-end parses valid mock data (M-5 owner check retired)", async function () {
            const h = await viem.deployContract("SwitchboardAccountOwnerHarness", []);
            await h.write.initialize([ACCT, DESC, MAX_STALENESS, FACTORY, PROGRAM_ID_A]);

            const valid = buildSwitchboardAccount({
                mantissa: 15_000_000_000n,
                scale: 8,
                timestamp: 1711900800,
            });
            await h.write.setMockAccount([ACCT, PROGRAM_ID_A, valid]);

            const [, , timestamp] = (await h.read.readAndParseExt()) as any;
            assert.equal(timestamp, 1711900800n);
        });
    });
});
