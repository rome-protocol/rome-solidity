import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { buildPythPullAccount } from "./helpers/mockPythPull.js";

/**
 * PriceBookProbeFast — the optimized-parse variant of the Phase-0 kernel.
 *
 * Two obligations:
 *   1. DIFFERENTIAL: for every input vector, the fast path must land exactly
 *      the same stored state and outcome (commit/skip/fault) as the legacy
 *      PythPullParser-based probe.
 *   2. SEMANTICS: the same write-path invariants as PriceBookProbe (fault
 *      isolation, monotonic skip, all-skip healthy, all-faulted revert,
 *      feed_id binding), plus fetch-failure handled as a per-feed fault
 *      (no revert bubbling from the account read).
 */

const ACCT_A = ("0x" + "aa".repeat(32)) as `0x${string}`;
const ACCT_B = ("0x" + "bb".repeat(32)) as `0x${string}`;
const FEED_ID_A = ("0x" + "11".repeat(32)) as `0x${string}`;
const FEED_ID_B = ("0x" + "22".repeat(32)) as `0x${string}`;

const build = (p: Partial<Parameters<typeof buildPythPullAccount>[0]> & { publishTime: number }) =>
    buildPythPullAccount({
        price: 123_456_789n,
        conf: 1_000n,
        expo: -8,
        feedId: FEED_ID_A,
        ...p,
    });

describe("PriceBookProbeFast", () => {
    let viem: any;
    let fast: any;
    let legacy: any;

    before(async () => {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        fast = await viem.deployContract("PriceBookProbeFastHarness", []);
        legacy = await viem.deployContract("PriceBookProbeHarness", []);
    });

    // ── differential: fast state == legacy state for every vector ──────
    const vectors: Array<[string, any]> = [
        ["plain expo -8", { publishTime: 1000 }],
        ["expo -5 (scale up)", { publishTime: 1001, expo: -5, price: 7_385n, conf: 10n }],
        ["expo -12 (scale down)", { publishTime: 1002, expo: -12, price: 191_342_712_530_123n }],
        ["expo 0", { publishTime: 1003, expo: 0, price: 42n, conf: 0n }],
        ["conf at exact bound", { publishTime: 1004, price: 10_000n, conf: 200n }],
        ["large price (BTC-ish)", { publishTime: 1005, price: 6_489_936_000_000n }],
        ["pt at u32 boundary", { publishTime: 4_294_967_295 }],
    ];
    for (const [name, params] of vectors) {
        it(`differential: ${name}`, async () => {
            const acct = ("0x" + Math.random().toString(16).slice(2).padEnd(8, "0").slice(0, 8) + "00".repeat(28)) as `0x${string}`;
            const data = build(params);
            await fast.write.setAccountData([acct, data]);
            await legacy.write.setAccountData([acct, data]);
            await fast.write.refreshAll([[acct], false]);
            await legacy.write.refreshAll([[acct], false]);
            const f = await fast.read.getEntry([acct]); // [answer, feedId, publishTime, status]
            const l = await legacy.read.entries([acct]); // [answer, feedId, publishTime, cachedAt, status]
            assert.equal(f[0], l[0], "answer");
            assert.equal(f[1], l[1], "feedId");
            assert.equal(f[2], l[2], "publishTime");
            assert.equal(f[3], BigInt(l[4]), "status");
        });
    }

    it("differential: outcome counts match legacy on a mixed batch", async () => {
        const ACCT_C = ("0x" + "33".repeat(32)) as `0x${string}`;
        const bad = build({ publishTime: 9000, discriminator: 0xdeadbeefdeadbeefn });
        const wide = build({ publishTime: 9000, price: 100n, conf: 3n, feedId: FEED_ID_B });
        const good = build({ publishTime: 9000, feedId: ("0x" + "44".repeat(32)) as `0x${string}` });
        for (const p of [fast, legacy]) {
            await p.write.setAccountData([ACCT_A, bad]);
            await p.write.setAccountData([ACCT_B, wide]);
            await p.write.setAccountData([ACCT_C, good]);
        }
        const { result: rf } = await fast.simulate.refreshAll([[ACCT_A, ACCT_B, ACCT_C], false]);
        const { result: rl } = await legacy.simulate.refreshAll([[ACCT_A, ACCT_B, ACCT_C], false]);
        assert.deepEqual(rf, rl); // committed/skipped/faulted identical
        assert.deepEqual(rf, [1n, 0n, 2n]);
    });

    // ── semantics on the fast path ──────────────────────────────────────
    it("commits, then all-skip is a healthy no-op, then force re-commits", async () => {
        await fast.write.setAccountData([ACCT_A, build({ publishTime: 2000 })]);
        await fast.write.setAccountData([ACCT_B, build({ publishTime: 2000, feedId: FEED_ID_B })]);
        await fast.write.refreshAll([[ACCT_A, ACCT_B], false]);

        const again = await fast.simulate.refreshAll([[ACCT_A, ACCT_B], false]);
        assert.deepEqual(again.result, [0n, 2n, 0n]);

        const forced = await fast.simulate.refreshAll([[ACCT_A, ACCT_B], true]);
        assert.deepEqual(forced.result, [2n, 0n, 0n]);
    });

    it("older publishTime never rolls back", async () => {
        await fast.write.setAccountData([ACCT_A, build({ publishTime: 100 })]);
        const { result } = await fast.simulate.refreshAll([[ACCT_A], false]);
        assert.deepEqual(result, [0n, 1n, 0n]);
        const [, , publishTime] = await fast.read.getEntry([ACCT_A]);
        assert.equal(publishTime, 2000n);
        await fast.write.setAccountData([ACCT_A, build({ publishTime: 2000 })]);
    });

    it("feed_id mismatch faults after first bind; batch survives", async () => {
        await fast.write.setAccountData([ACCT_A, build({ publishTime: 3000, feedId: FEED_ID_B })]);
        const { result } = await fast.simulate.refreshAll([[ACCT_A, ACCT_B], true]);
        assert.deepEqual(result, [1n, 0n, 1n]);
        await fast.write.setAccountData([ACCT_A, build({ publishTime: 3000 })]);
    });

    it("fetch failure is a per-feed fault, not a revert", async () => {
        await fast.write.setFetchFail([ACCT_A, true]);
        const { result } = await fast.simulate.refreshAll([[ACCT_A, ACCT_B], true]);
        assert.deepEqual(result, [1n, 0n, 1n]);
        await fast.write.setFetchFail([ACCT_A, false]);
    });

    it("short account data is a per-feed fault", async () => {
        const acct = ("0x" + "cc".repeat(32)) as `0x${string}`;
        await fast.write.setAccountData([acct, "0x22f123639d7ef4cd"]);
        const { result } = await fast.simulate.refreshAll([[acct, ACCT_B], true]);
        assert.deepEqual(result, [1n, 0n, 1n]);
    });

    it("partial verification variant is a per-feed fault", async () => {
        const acct = ("0x" + "dd".repeat(32)) as `0x${string}`;
        await fast.write.setAccountData([acct, build({ publishTime: 1, verificationVariant: 0x00 })]);
        const { result } = await fast.simulate.refreshAll([[acct, ACCT_B], true]);
        assert.deepEqual(result, [1n, 0n, 1n]);
    });

    it("non-positive price is a per-feed fault", async () => {
        const acct = ("0x" + "ee".repeat(32)) as `0x${string}`;
        await fast.write.setAccountData([acct, build({ publishTime: 1, price: 0n })]);
        const { result } = await fast.simulate.refreshAll([[acct, ACCT_B], true]);
        assert.deepEqual(result, [1n, 0n, 1n]);
    });

    it("reverts ONLY when every attempted feed faulted", async () => {
        const p2 = await viem.deployContract("PriceBookProbeFastHarness", []);
        await p2.write.setFetchFail([ACCT_A, true]);
        await p2.write.setFetchFail([ACCT_B, true]);
        await assert.rejects(p2.simulate.refreshAll([[ACCT_A, ACCT_B], false]), /AllFeedsFaulted/);
    });

    it("empty feed list is a no-op", async () => {
        const { result } = await fast.simulate.refreshAll([[], false]);
        assert.deepEqual(result, [0n, 0n, 0n]);
    });

    // ── decomposition entrypoints exist and count correctly ────────────
    it("fetchAll / parseAllFast / parseAllLegacy report ok-counts", async () => {
        const { result: f } = await fast.simulate.fetchAll([[ACCT_A, ACCT_B]]);
        assert.equal(f, 2n);
        const { result: pf } = await fast.simulate.parseAllFast([[ACCT_A, ACCT_B]]);
        assert.equal(pf, 2n);
        const { result: pl } = await fast.simulate.parseAllLegacy([[ACCT_A, ACCT_B]]);
        assert.equal(pl, 2n);
    });
});
