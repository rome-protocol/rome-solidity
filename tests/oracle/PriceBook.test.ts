import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { buildPythPullAccount } from "./helpers/mockPythPull.js";

/**
 * PriceBook — A1 semantic matrix from the PriceBook spec
 * (rome-specs active/technical/oracle-pricebook.md):
 *   registration (owner-gated, validates source, deploys adapter, solo first
 *   refresh inline), permissionless refreshAll, monotonic skip, future-pt
 *   fault, value-bound faults, feed-id binding, unregistered fault,
 *   pause = healthy write-side skip, all-faulted-only revert (per call),
 *   empty no-op, automatic fault recovery, cheap-skip with the
 *   age > window/2 bypass.
 *
 * Harness overrides the account reads (precompile unavailable on the
 * simulated network): per-account full bytes, an independent peek value
 * (so cheap-skip short-circuit is observable), and a settable account owner.
 */

const RECEIVER = ("0x" + "de".repeat(32)) as `0x${string}`;
const ACCT_A = ("0x" + "aa".repeat(32)) as `0x${string}`;
const ACCT_B = ("0x" + "bb".repeat(32)) as `0x${string}`;
const ACCT_C = ("0x" + "cc".repeat(32)) as `0x${string}`;
const FEED_A = ("0x" + "11".repeat(32)) as `0x${string}`;
const FEED_B = ("0x" + "22".repeat(32)) as `0x${string}`;
const WINDOW = 3600n;

describe("PriceBook", () => {
    let viem: any;
    let pc: any;
    let book: any;
    let impl: any;

    const nowTs = async () => Number((await pc.getBlock()).timestamp);
    const fresh = async (opts: any = {}) =>
        buildPythPullAccount({
            price: 300_000_000_000n,
            conf: 0n,
            expo: -8,
            publishTime: (await nowTs()) - 30,
            feedId: FEED_A,
            ...opts,
        });

    async function deployBook() {
        impl = await viem.deployContract("BookFeedAdapter", []);
        return viem.deployContract("PriceBookHarness", [RECEIVER, impl.address]);
    }
    async function register(b: any, acct: `0x${string}`, feedId: `0x${string}`, data: `0x${string}`) {
        await b.write.setAccountData([acct, data]);
        await b.write.registerFeed([acct, feedId, 200n, "X / USD", WINDOW]);
        return b.read.adapterOf([acct]);
    }

    before(async () => {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        pc = await viem.getPublicClient();
    });

    // ── registration ────────────────────────────────────────────────────
    it("registers a feed: validates source, deploys adapter, solo first refresh inline", async () => {
        book = await deployBook();
        const adapter = await register(book, ACCT_A, FEED_A, await fresh());
        assert.notEqual(adapter, "0x0000000000000000000000000000000000000000");
        const [answer, , , status] = await book.read.entryOf([ACCT_A]);
        assert.equal(answer, 300_000_000_000n); // active immediately — no uninit window
        assert.equal(status, 1);
        assert.equal(await book.read.registrationCount(), 1n);
        assert.equal((await book.read.registrationAt([0n])).toLowerCase(), ACCT_A.toLowerCase());
    });

    it("registration rejects: wrong account owner, feed-id mismatch, duplicate, non-owner, bad staleness", async () => {
        const b = await deployBook();
        await b.write.setAccountData([ACCT_A, await fresh()]);

        await b.write.setAccountOwner([ACCT_A, ("0x" + "01".repeat(32)) as `0x${string}`]);
        await assert.rejects(b.write.registerFeed([ACCT_A, FEED_A, 200n, "X", WINDOW]), /InvalidSourceOwner/);
        await b.write.setAccountOwner([ACCT_A, RECEIVER]);

        // wrong expectedFeedId: the inline solo first refresh fails fast with
        // the wrapped per-feed reason (0xc2a25c1b == FeedIdMismatch.selector)
        await assert.rejects(
            b.write.registerFeed([ACCT_A, FEED_B, 200n, "X", WINDOW]),
            /RegistrationRefreshFailed[\s\S]*0xc2a25c1b/,
        );

        await b.write.registerFeed([ACCT_A, FEED_A, 200n, "X", WINDOW]);
        await assert.rejects(b.write.registerFeed([ACCT_A, FEED_A, 200n, "X", WINDOW]), /AlreadyRegistered/);

        const [, other] = await viem.getWalletClients();
        await assert.rejects(
            b.write.registerFeed([ACCT_B, FEED_B, 200n, "X", WINDOW], { account: other.account }),
            /NotOwner/,
        );
        await assert.rejects(b.write.registerFeed([ACCT_B, FEED_B, 200n, "X", 0n]), /StalenessOutOfRange/);
    });

    // ── refreshAll semantics ────────────────────────────────────────────
    it("commits newer, skips not-newer, is permissionless", async () => {
        book = await deployBook();
        await register(book, ACCT_A, FEED_A, await fresh());
        const [, pt0] = await book.read.entryOf([ACCT_A]);

        // not newer → skip (send from a non-owner account: permissionless)
        const [, other] = await viem.getWalletClients();
        const r1 = await book.simulate.refreshAll([[ACCT_A]], { account: other.account });
        assert.deepEqual(r1.result, [0n, 1n, 0n]);

        // newer → commit
        await book.write.setAccountData([ACCT_A, await fresh({ publishTime: Number(pt0) + 10 })]);
        await book.write.setPeekValue([ACCT_A, pt0 + 10n]);
        const r2 = await book.simulate.refreshAll([[ACCT_A]], { account: other.account });
        assert.deepEqual(r2.result, [1n, 0n, 0n]);
    });

    it("faults: future publishTime, wide confidence, non-positive price, feed-id mismatch, unregistered", async () => {
        const b = await deployBook();
        await register(b, ACCT_A, FEED_A, await fresh());
        await register(b, ACCT_B, FEED_B, await fresh({ feedId: FEED_B }));
        const now = await nowTs();

        const cases: Array<[string, `0x${string}`]> = [
            ["future pt", await fresh({ publishTime: now + 900 })],
            ["wide conf", await fresh({ publishTime: now + 5, price: 100n, conf: 3n })],
            ["zero price", await fresh({ publishTime: now + 5, price: 0n })],
            ["wrong feed id", await fresh({ publishTime: now + 5, feedId: FEED_B })],
        ];
        for (const [name, bytes] of cases) {
            await b.write.setAccountData([ACCT_A, bytes]);
            await b.write.setPeekValue([ACCT_A, BigInt(now + 900)]);
            const { result } = await b.simulate.refreshAll([[ACCT_A, ACCT_B]]);
            assert.deepEqual(result, [0n, 1n, 1n], `${name}: expected fault + B skip`); // B not-newer
        }
        const { result } = await b.simulate.refreshAll([[ACCT_C, ACCT_B]]);
        assert.deepEqual(result, [0n, 1n, 1n], "unregistered faults, B skips");
    });

    it("entry is never rolled back or overwritten by a faulting round", async () => {
        const b = await deployBook();
        await register(b, ACCT_A, FEED_A, await fresh());
        const [answer0, pt0] = await b.read.entryOf([ACCT_A]);
        await b.write.setAccountData([ACCT_A, await fresh({ publishTime: Number(pt0) + 10, price: 0n })]);
        await b.write.setPeekValue([ACCT_A, pt0 + 10n]);
        await assert.rejects(b.write.refreshAll([[ACCT_A]]), /AllFeedsFaulted/); // sole feed faulted
        const [answer1, pt1] = await b.read.entryOf([ACCT_A]);
        assert.equal(answer1, answer0);
        assert.equal(pt1, pt0);
    });

    it("recovers automatically on the next valid update after a fault", async () => {
        const b = await deployBook();
        await register(b, ACCT_A, FEED_A, await fresh());
        const [, pt0] = await b.read.entryOf([ACCT_A]);
        await b.write.setAccountData([ACCT_A, await fresh({ publishTime: Number(pt0) + 5, price: 0n })]);
        await b.write.setPeekValue([ACCT_A, pt0 + 5n]);
        await assert.rejects(b.write.refreshAll([[ACCT_A]]), /AllFeedsFaulted/);
        await b.write.setAccountData([ACCT_A, await fresh({ publishTime: Number(pt0) + 6 })]);
        await b.write.setPeekValue([ACCT_A, pt0 + 6n]);
        const { result } = await b.simulate.refreshAll([[ACCT_A]]);
        assert.deepEqual(result, [1n, 0n, 0n]);
    });

    it("pause is a healthy write-side skip and never counts toward all-faulted", async () => {
        const b = await deployBook();
        const adapter = await register(b, ACCT_A, FEED_A, await fresh());
        await b.write.pauseAdapter([adapter]);
        assert.equal(await b.read.isPaused([adapter]), true);

        const { result } = await b.simulate.refreshAll([[ACCT_A]]);
        assert.deepEqual(result, [0n, 1n, 0n], "paused → skip, no revert despite zero commits");

        await b.write.unpauseAdapter([adapter]);
        assert.equal(await b.read.isPaused([adapter]), false);
    });

    it("reverts AllFeedsFaulted only when every attempted feed faulted; empty list is a no-op", async () => {
        const b = await deployBook();
        await register(b, ACCT_A, FEED_A, await fresh());
        const { result: empty } = await b.simulate.refreshAll([[]]);
        assert.deepEqual(empty, [0n, 0n, 0n]);
        await assert.rejects(b.simulate.refreshAll([[ACCT_B, ACCT_C]]), /AllFeedsFaulted/); // both unregistered
    });

    // ── cheap-skip + bypass ─────────────────────────────────────────────
    it("cheap-skip short-circuits on peek within window/2; full path runs beyond it", async () => {
        const b = await deployBook();
        await register(b, ACCT_A, FEED_A, await fresh());
        const [, pt0] = await b.read.entryOf([ACCT_A]);

        // Fresh entry (age < window/2). Full data WOULD commit (newer), but the
        // peek reports not-newer → cheap-skip short-circuits to SKIP: proof the
        // full fetch+parse never ran.
        await b.write.setAccountData([ACCT_A, await fresh({ publishTime: Number(pt0) + 20 })]);
        await b.write.setPeekValue([ACCT_A, pt0]);
        const r1 = await b.simulate.refreshAll([[ACCT_A]]);
        assert.deepEqual(r1.result, [0n, 1n, 0n], "peek short-circuit expected");

        // Age the entry past window/2 → bypass: full path runs and COMMITS the
        // newer data even though the peek still claims not-newer.
        await b.write.setEntryAgeForTest([ACCT_A, WINDOW / 2n + 60n]);
        const r2 = await b.simulate.refreshAll([[ACCT_A]]);
        assert.deepEqual(r2.result, [1n, 0n, 0n], "bypass must take the full validated path");
    });
});
