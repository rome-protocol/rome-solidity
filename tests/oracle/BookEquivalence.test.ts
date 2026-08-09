import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import hardhat from "hardhat";
import { buildPythPullAccount } from "./helpers/mockPythPull.js";

/**
 * A2 — ABI-equivalence suite (spec R5): the identical call matrix against a
 * legacy CachedPythAdapter and a BookFeedAdapter must produce identical
 * selectors, revert data, and decoded outputs.
 *
 * Matrix: uninitialized / fresh / stale / getRoundData / decimals / version /
 * description / metadata shape. Pause is intentionally NOT in the read
 * matrix — it's a deliberate divergence (S5-F3): legacy's read path has no
 * pause check (verified: _checkPaused gates only refresh()), while the
 * book's read path now fails closed on pause. See BookPauseFailClosed.test.ts
 * for the book's own pause/unpause matrix.
 */

const RECEIVER = ("0x" + "de".repeat(32)) as `0x${string}`;
const ACCT = ("0x" + "aa".repeat(32)) as `0x${string}`;
const FEED = ("0x" + "11".repeat(32)) as `0x${string}`;
const FACTORY_NONE = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const DESC = "SOL / USD";
const WINDOW = 3600n;

describe("BookFeedAdapter ≡ CachedPythAdapter (A2)", () => {
    let viem: any;
    let pc: any;

    const nowTs = async () => Number((await pc.getBlock()).timestamp);
    const bytes = async (pt?: number) =>
        buildPythPullAccount({
            price: 7_385_800_000n,
            conf: 1_000n,
            expo: -8,
            publishTime: pt ?? (await nowTs()) - 30,
            feedId: FEED,
        });

    before(async () => {
        const conn = await hardhat.network.connect();
        viem = conn.viem;
        pc = await viem.getPublicClient();
    });

    /** Deploy both sides served by the same account bytes. */
    async function pair(data: `0x${string}`, opts: { window?: bigint; register?: boolean } = {}) {
        const window = opts.window ?? WINDOW;
        const legacy = await viem.deployContract("CachedPythAdapterHarness", []);
        await legacy.write.initialize([ACCT, DESC, window, FACTORY_NONE]);
        await legacy.write.setMockData([data]);

        const impl = await viem.deployContract("BookFeedAdapter", []);
        const book = await viem.deployContract("PriceBookHarness", [RECEIVER, impl.address]);
        await book.write.setAccountData([ACCT, data]);
        let bookAdapter: `0x${string}`;
        if (opts.register === false) {
            // uninitialized case: adapter over a never-registered account
            const bare = await viem.deployContract("BookFeedAdapterHarness", []);
            await bare.write.initialize([book.address, ACCT, DESC, window]);
            bookAdapter = bare.address;
        } else {
            await book.write.registerFeed([ACCT, FEED, 200n, DESC, window]);
            bookAdapter = await book.read.adapterOf([ACCT]);
        }
        const adapter = await viem.getContractAt("BookFeedAdapter", bookAdapter);
        return { legacy, book, adapter };
    }

    async function bothReject(a: any, b: any, fn: string, selector: string) {
        for (const [side, c] of [["legacy", a], ["book", b]] as const) {
            await assert.rejects(
                c.read[fn](),
                (e: any) => e.message.includes(selector),
                `${side}.${fn} must revert ${selector}`,
            );
        }
    }

    it("uninitialized: both revert UninitializedPriceFeed", async () => {
        const { legacy, adapter } = await pair(await bytes(), { register: false });
        // legacy: initialized but never refreshed; book: adapter over unregistered account
        await bothReject(legacy, adapter, "latestRoundData", "UninitializedPriceFeed");
    });

    it("fresh: identical decoded outputs", async () => {
        const data = await bytes();
        const { legacy, adapter } = await pair(data);
        await legacy.write.refresh([]);
        const l = (await legacy.read.latestRoundData()) as readonly bigint[];
        const b = (await adapter.read.latestRoundData()) as readonly bigint[];
        assert.deepEqual([...b], [...l], "roundId/answer/startedAt/updatedAt/answeredInRound identical");
    });

    it("stale: both revert StalePriceFeed under the same window math", async () => {
        const data = await bytes(); // fresh now, WINDOW=3600
        const { legacy, adapter } = await pair(data);
        await legacy.write.refresh([]); // both sides now cache the same round

        const test = await viem.getTestClient();
        await test.increaseTime({ seconds: 7200 }); // age past the window
        await test.mine({ blocks: 1 });

        await bothReject(legacy, adapter, "latestRoundData", "StalePriceFeed");
    });

    it("getRoundData: both revert HistoricalRoundsNotSupported", async () => {
        const { legacy, adapter } = await pair(await bytes());
        for (const c of [legacy, adapter]) {
            await assert.rejects(c.read.getRoundData([1n]), (e: any) => e.message.includes("HistoricalRoundsNotSupported"));
        }
    });

    it("decimals / version / description identical", async () => {
        const { legacy, adapter } = await pair(await bytes());
        assert.equal(await adapter.read.decimals(), await legacy.read.decimals());
        assert.equal(await adapter.read.version(), await legacy.read.version());
        assert.equal(await adapter.read.description(), await legacy.read.description());
    });

    it("metadata: same shape and field semantics (factory/createdAt excepted by design)", async () => {
        const { legacy, adapter } = await pair(await bytes());
        await legacy.write.refresh([]);
        const l = (await legacy.read.metadata()) as any;
        const b = (await adapter.read.metadata()) as any;
        assert.equal(b.description, l.description);
        assert.equal(b.sourceType, l.sourceType);
        assert.equal(b.solanaAccount, l.solanaAccount);
        assert.equal(b.maxStaleness, l.maxStaleness);
        assert.equal(b.paused, false);
    });
});
