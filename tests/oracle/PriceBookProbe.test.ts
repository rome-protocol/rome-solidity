import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { buildPythPullAccount } from "./helpers/mockPythPull.js";

/**
 * PriceBookProbe — semantics tests for the Phase-0 measurement kernel of the
 * PriceBook spec (rome-specs#204).
 *
 * The probe encodes the spec's write-path invariants so the CU numbers it
 * produces on a live chain are measured against honest behavior:
 *   - per-feed try-unit isolation (one bad feed never reverts the batch)
 *   - monotonic publishTime (older/equal source → per-feed skip, not revert)
 *   - all-skip is a HEALTHY no-op; only every-feed-faulted reverts
 *   - confidence / positive-price bounds → per-feed fault
 *   - feed_id integrity: bound on first write, later mismatch → per-feed fault
 */

const ACCT_A = ("0x" + "aa".repeat(32)) as `0x${string}`;
const ACCT_B = ("0x" + "bb".repeat(32)) as `0x${string}`;
const FEED_ID_A = ("0x" + "11".repeat(32)) as `0x${string}`;
const FEED_ID_B = ("0x" + "22".repeat(32)) as `0x${string}`;

const fresh = (publishTime: number, feedId: `0x${string}` = FEED_ID_A) =>
    buildPythPullAccount({
        price: 123_456_789n, // expo -8 → normalized answer 123_456_789
        conf: 1_000n, //  well under 2% of price
        expo: -8,
        publishTime,
        feedId,
    });

describe("PriceBookProbe", () => {
    let viem: any;
    let probe: any;
    let pc: any;

    async function deployProbe() {
        return viem.deployContract("PriceBookProbeHarness", []);
    }

    before(async () => {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        pc = await viem.getPublicClient();
    });

    it("commits fresh feeds and stores normalized entries", async () => {
        probe = await deployProbe();
        await probe.write.setAccountData([ACCT_A, fresh(1000)]);
        await probe.write.setAccountData([ACCT_B, fresh(1000, FEED_ID_B)]);

        const { result } = await probe.simulate.refreshAll([[ACCT_A, ACCT_B], false]);
        assert.deepEqual(result, [2n, 0n, 0n]); // committed, skipped, faulted
        await probe.write.refreshAll([[ACCT_A, ACCT_B], false]);

        const [answer, feedId, publishTime, , status] = await probe.read.entries([ACCT_A]);
        assert.equal(answer, 123_456_789n);
        assert.equal(feedId, FEED_ID_A);
        assert.equal(publishTime, 1000n);
        assert.equal(status, 1);
    });

    it("all-skip (nothing newer) is a healthy no-op, NOT a revert", async () => {
        const { result } = await probe.simulate.refreshAll([[ACCT_A, ACCT_B], false]);
        assert.deepEqual(result, [0n, 2n, 0n]);
    });

    it("an older source publishTime can never roll the entry back", async () => {
        await probe.write.setAccountData([ACCT_A, fresh(500)]);
        const { result } = await probe.simulate.refreshAll([[ACCT_A], false]);
        assert.deepEqual(result, [0n, 1n, 0n]);
        const [, , publishTime] = await probe.read.entries([ACCT_A]);
        assert.equal(publishTime, 1000n); // unchanged
        await probe.write.setAccountData([ACCT_A, fresh(1000)]); // restore
    });

    it("force=true re-commits the full write path for capacity runs", async () => {
        const { result } = await probe.simulate.refreshAll([[ACCT_A], true]);
        assert.deepEqual(result, [1n, 0n, 0n]);
    });

    it("isolates a malformed feed; the rest of the batch commits", async () => {
        const bad = buildPythPullAccount({
            discriminator: 0xdeadbeefdeadbeefn,
            price: 1n,
            conf: 0n,
            expo: -8,
            publishTime: 2000,
        });
        await probe.write.setAccountData([ACCT_A, bad]);
        await probe.write.setAccountData([ACCT_B, fresh(2000, FEED_ID_B)]);

        const { result } = await probe.simulate.refreshAll([[ACCT_A, ACCT_B], false]);
        assert.deepEqual(result, [1n, 0n, 1n]);

        const hash = await probe.write.refreshAll([[ACCT_A, ACCT_B], false]);
        const receipt = await pc.waitForTransactionReceipt({ hash });
        assert.equal(receipt.status, "success");
        await probe.write.setAccountData([ACCT_A, fresh(3000)]); // restore
    });

    it("a faulted feed recovers automatically on the next valid update", async () => {
        // ACCT_A was malformed in the previous test and is now valid again.
        const { result } = await probe.simulate.refreshAll([[ACCT_A], false]);
        assert.deepEqual(result, [1n, 0n, 0n]);
    });

    it("reverts ONLY when every attempted feed faulted", async () => {
        const bad = buildPythPullAccount({
            discriminator: 0xdeadbeefdeadbeefn,
            price: 1n,
            conf: 0n,
            expo: -8,
            publishTime: 4000,
        });
        const probe2 = await deployProbe();
        await probe2.write.setAccountData([ACCT_A, bad]);
        await probe2.write.setAccountData([ACCT_B, bad]);
        await assert.rejects(
            probe2.simulate.refreshAll([[ACCT_A, ACCT_B], false]),
            /AllFeedsFaulted/,
        );
    });

    it("faults a feed whose confidence exceeds the bound; batch survives", async () => {
        const wide = buildPythPullAccount({
            price: 100n,
            conf: 3n, // 3% > MAX_CONF_BPS (2%)
            expo: -8,
            publishTime: 5000,
            feedId: FEED_ID_A,
        });
        await probe.write.setAccountData([ACCT_A, wide]);
        await probe.write.setAccountData([ACCT_B, fresh(5000, FEED_ID_B)]);
        const { result } = await probe.simulate.refreshAll([[ACCT_A, ACCT_B], false]);
        assert.deepEqual(result, [1n, 0n, 1n]);
        await probe.write.setAccountData([ACCT_A, fresh(6000)]); // restore
    });

    it("faults a feed whose account carries a different feed_id than first bound", async () => {
        // ACCT_A was bound to FEED_ID_A on its first commit; serve it B's id.
        await probe.write.setAccountData([ACCT_A, fresh(7000, FEED_ID_B)]);
        const { result } = await probe.simulate.refreshAll([[ACCT_A, ACCT_B], true]);
        assert.deepEqual(result, [1n, 0n, 1n]);
        await probe.write.setAccountData([ACCT_A, fresh(7000)]); // restore
    });

    it("faults a non-positive price; batch survives", async () => {
        const zero = buildPythPullAccount({
            price: 0n,
            conf: 0n,
            expo: -8,
            publishTime: 8000,
            feedId: FEED_ID_A,
        });
        await probe.write.setAccountData([ACCT_A, zero]);
        const { result } = await probe.simulate.refreshAll([[ACCT_A, ACCT_B], true]);
        assert.deepEqual(result, [1n, 0n, 1n]);
    });

    it("empty feed list is a no-op", async () => {
        const { result } = await probe.simulate.refreshAll([[], false]);
        assert.deepEqual(result, [0n, 0n, 0n]);
    });

    it("refreshOne is self-callable only", async () => {
        await assert.rejects(probe.simulate.refreshOne([ACCT_A, false]), /SelfOnly/);
    });
});
