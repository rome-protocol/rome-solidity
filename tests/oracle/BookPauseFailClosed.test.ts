import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { decodeEventLog } from "viem";
import { buildPythPullAccount } from "./helpers/mockPythPull.js";

/**
 * S5-F3 — the book's pause must fail closed on the read path.
 *
 * Before this fix, BookFeedAdapter.latestRoundData() had no pause check: a
 * paused feed kept serving its last cached answer until it aged out on its
 * own. This matrix locks in the fix: pause flips the served entry's status
 * byte (answer/publishTime/cachedAt retained) so reads revert AdapterPaused
 * immediately; unpause re-validates against the live source — strictly newer
 * than the retained entry AND fresh within maxStaleness — before it can
 * resume serving, and any failure rolls back atomically (pause/unpause never
 * substitutes for a real source read).
 */

const RECEIVER = ("0x" + "de".repeat(32)) as `0x${string}`;
const ACCT_A = ("0x" + "aa".repeat(32)) as `0x${string}`;
const FEED_A = ("0x" + "11".repeat(32)) as `0x${string}`;
const WINDOW = 3600n; // maxStaleness, seconds
const P0 = 300_000_000_000n;

const priceAt = (publishTime: number, price: bigint = P0) =>
    buildPythPullAccount({ price, conf: 0n, expo: -8, publishTime, feedId: FEED_A });

describe("PriceBook / BookFeedAdapter — pause fails closed", () => {
    let viem: any;
    let pc: any;
    let impl: any;

    const nowTs = async () => Number((await pc.getBlock()).timestamp);

    async function deployBook() {
        impl = await viem.deployContract("BookFeedAdapter", []);
        return viem.deployContract("PriceBookHarness", [RECEIVER, impl.address]);
    }

    /** Register ACCT_A with a fresh P0 and return the book + its adapter. */
    async function registerFresh(b: any) {
        const pt0 = (await nowTs()) - 30;
        await b.write.setAccountData([ACCT_A, priceAt(pt0)]);
        await b.write.registerFeed([ACCT_A, FEED_A, 200n, "X / USD", WINDOW]);
        const adapterAddr = (await b.read.adapterOf([ACCT_A])) as `0x${string}`;
        const adapter = await viem.getContractAt("BookFeedAdapter", adapterAddr);
        return { adapterAddr, adapter, pt0 };
    }

    before(async () => {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        pc = await viem.getPublicClient();
    });

    it("pause reverts AdapterPaused on read and overwrites ONLY the status byte", async () => {
        const b = await deployBook();
        const { adapterAddr, adapter } = await registerFresh(b);

        const live = (await adapter.read.latestRoundData()) as readonly bigint[];
        assert.equal(live[1], P0, "adapter serves P0 before pause");

        const entry0 = await b.read.entryOf([ACCT_A]);
        assert.equal(entry0[3], 1, "status is live before pause");

        await b.write.pauseAdapter([adapterAddr]);
        await assert.rejects(adapter.read.latestRoundData(), /AdapterPaused/);

        const entry1 = await b.read.entryOf([ACCT_A]);
        assert.equal(entry1[0], entry0[0], "answer retained");
        assert.equal(entry1[1], entry0[1], "publishTime retained");
        assert.equal(entry1[2], entry0[2], "cachedAt retained");
        assert.equal(entry1[3], 2, "status flips to paused, and ONLY the status byte changed");
    });

    it("unpause reverts UnpauseSourceNotNewer when the source hasn't advanced; stays paused", async () => {
        const b = await deployBook();
        const { adapterAddr, adapter } = await registerFresh(b);
        await b.write.pauseAdapter([adapterAddr]);
        assert.equal(await b.read.isPaused([adapterAddr]), true);
        const entryBefore = await b.read.entryOf([ACCT_A]);

        // Source account data is untouched — same publishTime as P0.
        await assert.rejects(b.write.unpauseAdapter([adapterAddr]), /UnpauseSourceNotNewer/);

        assert.equal(await b.read.isPaused([adapterAddr]), true, "_paused rolled back to true");
        const entryAfter = await b.read.entryOf([ACCT_A]);
        assert.deepEqual([...entryAfter], [...entryBefore], "entry unchanged");
        await assert.rejects(adapter.read.latestRoundData(), /AdapterPaused/, "reads still gated");
    });

    it("unpause reverts UnpauseStalePrice when the newer source price is itself stale, and rolls back the commit", async () => {
        const b = await deployBook();
        const { adapterAddr, adapter, pt0 } = await registerFresh(b);
        await b.write.pauseAdapter([adapterAddr]);
        const entryPaused = await b.read.entryOf([ACCT_A]);
        assert.equal(entryPaused[3], 2, "paused marker set before the doomed unpause attempt");

        // Strictly newer than pt0, but by the time unpause runs the chain
        // clock has moved well past maxStaleness relative to this publishTime.
        await b.write.setAccountData([ACCT_A, priceAt(pt0 + 10)]);
        const test = await viem.getTestClient();
        await test.increaseTime({ seconds: Number(WINDOW) + 100 });
        await test.mine({ blocks: 1 });

        await assert.rejects(b.write.unpauseAdapter([adapterAddr]), /UnpauseStalePrice/);

        // _refreshOne committed the newer-but-stale price mid-call; the
        // revert must unwind that commit too — the entry has to land back on
        // exactly the paused-P0 marker, not the reverted P1 commit.
        assert.equal(await b.read.isPaused([adapterAddr]), true, "stays paused");
        const entryAfter = await b.read.entryOf([ACCT_A]);
        assert.deepEqual(
            [...entryAfter],
            [...entryPaused],
            "entry rolled back to the paused marker, not left at the reverted commit",
        );
        await assert.rejects(adapter.read.latestRoundData(), /AdapterPaused/, "reads still gated");
    });

    it("unpause succeeds when the source is strictly newer AND fresh: emits FeedRefreshed, serves P1", async () => {
        const b = await deployBook();
        const { adapterAddr, adapter, pt0 } = await registerFresh(b);
        await b.write.pauseAdapter([adapterAddr]);

        const p1Pt = pt0 + 10;
        const p1Price = 305_000_000_000n;
        await b.write.setAccountData([ACCT_A, priceAt(p1Pt, p1Price)]);

        const hash = await b.write.unpauseAdapter([adapterAddr]);
        const receipt = await pc.waitForTransactionReceipt({ hash });
        assert.equal(receipt.status, "success");

        const refreshed = receipt.logs
            .map((log: any) => {
                try {
                    return decodeEventLog({ abi: b.abi, data: log.data, topics: log.topics });
                } catch {
                    return null;
                }
            })
            .find((e: any) => e?.eventName === "FeedRefreshed");
        assert.ok(refreshed, "FeedRefreshed emitted");
        assert.equal((refreshed as any).args.answer, p1Price);
        assert.equal((refreshed as any).args.publishTime, BigInt(p1Pt));

        assert.equal(await b.read.isPaused([adapterAddr]), false);
        const entry = await b.read.entryOf([ACCT_A]);
        assert.equal(entry[3], 1, "status back to live");

        const live = (await adapter.read.latestRoundData()) as readonly bigint[];
        assert.equal(live[1], p1Price, "adapter now serves P1");
    });

    it("unpause on a never-paused feed is a harmless no-op", async () => {
        const b = await deployBook();
        const { adapterAddr, adapter } = await registerFresh(b);
        assert.equal(await b.read.isPaused([adapterAddr]), false);
        const entryBefore = await b.read.entryOf([ACCT_A]);

        // Live, never-paused feed: must NOT revert (the bulk/blind-unpause
        // footgun — without the guard this hits UnpauseSourceNotNewer since
        // the source hasn't moved).
        const hash = await b.write.unpauseAdapter([adapterAddr]);
        const receipt = await pc.waitForTransactionReceipt({ hash });
        assert.equal(receipt.status, "success");

        assert.equal(await b.read.isPaused([adapterAddr]), false);
        const entryAfter = await b.read.entryOf([ACCT_A]);
        assert.deepEqual([...entryAfter], [...entryBefore], "entry untouched by the no-op");

        const live = (await adapter.read.latestRoundData()) as readonly bigint[];
        assert.equal(live[1], P0, "adapter still serves P0");
    });

    it("unpause reverts UnpauseRefreshFailed on a genuine per-feed fault, and rolls back", async () => {
        const b = await deployBook();
        const { adapterAddr, adapter, pt0 } = await registerFresh(b);
        await b.write.pauseAdapter([adapterAddr]);
        const entryPaused = await b.read.entryOf([ACCT_A]);
        assert.equal(entryPaused[3], 2, "paused marker set before the doomed unpause attempt");

        // Strictly newer than pt0 — so the cheap-skip peek sees a newer
        // publishTime and does NOT short-circuit to SKIP, and the full
        // monotonic guard doesn't SKIP either — but a non-positive price
        // faults the full validated read. OUTCOME_FAULT, not SKIP, not a
        // staleness gate: this is the UnpauseRefreshFailed leg.
        await b.write.setAccountData([ACCT_A, priceAt(pt0 + 10, 0n)]);

        await assert.rejects(b.write.unpauseAdapter([adapterAddr]), /UnpauseRefreshFailed/);

        // Full rollback: the fault happens before _refreshOne ever writes
        // _entries, and _paused must land back on true — entry must be
        // exactly the paused-P0 marker, with no mid-call state leaked.
        assert.equal(await b.read.isPaused([adapterAddr]), true, "stays paused");
        const entryAfter = await b.read.entryOf([ACCT_A]);
        assert.deepEqual(
            [...entryAfter],
            [...entryPaused],
            "entry rolled back to the paused marker — no mid-call state leaked",
        );
        await assert.rejects(adapter.read.latestRoundData(), /AdapterPaused/, "reads still gated");
    });
});
