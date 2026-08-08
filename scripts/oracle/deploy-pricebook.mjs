#!/usr/bin/env node
/**
 * PriceBook deploy + registration + in-situ capacity measurement.
 *
 * Flow (per the PriceBook spec's registration order):
 *   1. deploy BookFeedAdapter implementation + PriceBook(receiverId, impl)
 *   2. per feed: read the live source account, parse feed_id at offset 41,
 *      registerFeed(...) — the solo first refresh happens inside the tx
 *   3. cross-check book entries vs the deployed raw adapters (EXACT match)
 *   4. measured refreshAll runs at growing widths + a cheap-skip round,
 *      attributed from Solana receipts (CU, keys, size, execution shape)
 *
 * Env: RPC, SOLANA_RPC, EVM_KEY_FILE, FEEDS_JSON, ROME_EVM_PROGRAM (as the
 * triage driver), RECEIVER_ID (bytes32 hex — read it from the OG-V2 factory:
 * cast call <factory> "pythReceiverProgramId()(bytes32)"), MAX_STALENESS
 * (default 300), BOOK (reuse a deployed book; skips deploy+register), OUT.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const need = (k) => {
    const v = process.env[k];
    if (!v) {
        console.error(`missing env ${k}`);
        process.exit(1);
    }
    return v;
};
const RPC = need("RPC");
const SOLANA_RPC = need("SOLANA_RPC");
const KEY_FILE = need("EVM_KEY_FILE");
const FEEDS_JSON = need("FEEDS_JSON");
const PROGRAM = need("ROME_EVM_PROGRAM");
const RECEIVER_ID = need("RECEIVER_ID");
const MAX_STALENESS = BigInt(process.env.MAX_STALENESS ?? "300");
const OUT = process.env.OUT ?? "pricebook-deploy-results.json";

const BOOK_ART = JSON.parse(readFileSync(new URL("../../artifacts/contracts/oracle/PriceBook.sol/PriceBook.json", import.meta.url)));
const IMPL_ART = JSON.parse(readFileSync(new URL("../../artifacts/contracts/oracle/BookFeedAdapter.sol/BookFeedAdapter.json", import.meta.url)));
const AGG_ABI = [
    {
        type: "function",
        name: "latestRoundData",
        stateMutability: "view",
        inputs: [],
        outputs: [
            { name: "roundId", type: "uint80" },
            { name: "answer", type: "int256" },
            { name: "startedAt", type: "uint256" },
            { name: "updatedAt", type: "uint256" },
            { name: "answeredInRound", type: "uint80" },
        ],
    },
];

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58ToBytes32(s) {
    let n = 0n;
    for (const c of s) {
        const i = B58.indexOf(c);
        if (i < 0) throw new Error(`bad base58: ${s}`);
        n = n * 58n + BigInt(i);
    }
    let hex = n.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    let zeros = 0;
    for (const c of s) {
        if (c === "1") zeros++;
        else break;
    }
    const out = Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
    if (out.length !== 32) throw new Error(`${s} decodes to ${out.length} bytes, want 32`);
    return "0x" + out.toString("hex");
}

let solId = 0;
async function sol(method, params) {
    const res = await fetch(SOLANA_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++solId, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── inputs ──────────────────────────────────────────────────────────────
const reg = JSON.parse(readFileSync(FEEDS_JSON, "utf8"));
const FEEDS = Object.entries(reg.feeds)
    .filter(([, f]) => f.source === "pyth")
    .map(([name, f]) => ({ name, rawAdapter: f.address, pda: f.underlyingAccount, acct: b58ToBytes32(f.underlyingAccount) }));
if (FEEDS.length === 0) throw new Error("no pyth feeds in FEEDS_JSON");
const anchorPda = FEEDS[0].pda;

const account = privateKeyToAccount(readFileSync(KEY_FILE, "utf8").trim());
const transport = http(RPC, { timeout: 180_000 }); // proxy executes synchronously; wide batches exceed the 10s default
const pub = createPublicClient({ transport });
const wallet = createWalletClient({ account, transport });
const gasPrice = await pub.getGasPrice();
const chainId = await pub.getChainId();
console.log(`chain ${chainId} · sender ${account.address} · ${FEEDS.length} pyth feeds · window ${MAX_STALENESS}s`);

async function send(desc, fn) {
    for (let attempt = 1; ; attempt++) {
        try {
            const hash = await fn();
            const rc = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
            if (rc.status !== "success") throw new Error(`${desc}: reverted on-chain (${hash})`);
            return rc;
        } catch (e) {
            if (attempt >= 3 || /reverted on-chain/.test(e.message ?? "")) throw e;
            console.log(`  ${desc}: retry ${attempt} (${(e.shortMessage ?? e.message ?? "").split("\n")[0].slice(0, 100)})`);
            await sleep(4000);
        }
    }
}

// ── 1. deploy ───────────────────────────────────────────────────────────
let book = process.env.BOOK;
let implAddr;
if (!book) {
    const rcImpl = await send("deploy impl", () =>
        wallet.deployContract({ abi: IMPL_ART.abi, bytecode: IMPL_ART.bytecode, args: [], gasPrice, chain: null }),
    );
    implAddr = rcImpl.contractAddress;
    console.log(`BookFeedAdapter impl ${implAddr}`);
    const rcBook = await send("deploy book", () =>
        wallet.deployContract({ abi: BOOK_ART.abi, bytecode: BOOK_ART.bytecode, args: [RECEIVER_ID, implAddr], gasPrice, chain: null }),
    );
    book = rcBook.contractAddress;
    await sleep(6000); // fresh accounts are lock-TTL'd; let estimation settle
}
console.log(`PriceBook ${book}`);

// ── 2. register (solo first refresh inside each tx) ─────────────────────
const registered = [];
const failed = [];
if (!process.env.BOOK) {
    for (const f of FEEDS) {
        const info = await sol("getAccountInfo", [f.pda, { encoding: "base64" }]);
        if (!info?.value) {
            failed.push({ feed: f.name, reason: "source account missing" });
            continue;
        }
        const raw = Buffer.from(info.value.data[0], "base64");
        const feedId = "0x" + raw.subarray(41, 73).toString("hex");
        try {
            const rc = await send(`register ${f.name}`, () =>
                wallet.writeContract({
                    address: book,
                    abi: BOOK_ART.abi,
                    functionName: "registerFeed",
                    args: [f.acct, feedId, 0n, f.name, MAX_STALENESS],
                    gasPrice,
                    gas: 30_000_000n,
                    chain: null,
                }),
            );
            const adapter = await pub.readContract({ address: book, abi: BOOK_ART.abi, functionName: "adapterOf", args: [f.acct] });
            registered.push({ ...f, feedId, adapter, regGasUsed: rc.gasUsed.toString() });
            console.log(`  ${f.name.padEnd(12)} adapter ${adapter} (gasUsed ${rc.gasUsed})`);
        } catch (e) {
            failed.push({ feed: f.name, reason: (e.shortMessage ?? e.message ?? "").split("\n").slice(0, 3).join(" ") });
            console.log(`  ${f.name.padEnd(12)} REGISTRATION FAILED: ${failed.at(-1).reason.slice(0, 120)}`);
        }
    }
} else {
    const count = await pub.readContract({ address: book, abi: BOOK_ART.abi, functionName: "registrationCount", args: [] });
    for (let i = 0n; i < count; i++) {
        const acct = await pub.readContract({ address: book, abi: BOOK_ART.abi, functionName: "registrationAt", args: [i] });
        const f = FEEDS.find((x) => x.acct.toLowerCase() === acct.toLowerCase());
        if (f) registered.push({ ...f, adapter: await pub.readContract({ address: book, abi: BOOK_ART.abi, functionName: "adapterOf", args: [acct] }) });
    }
}
console.log(`registered ${registered.length}/${FEEDS.length}${failed.length ? ` (failed: ${failed.map((f) => f.feed).join(", ")})` : ""}`);
if (registered.length === 0) throw new Error("nothing registered");

// ── 3. cross-check vs raw adapters ──────────────────────────────────────
console.log("\ncross-check vs deployed raw adapters:");
const checks = [];
for (const f of registered.slice(0, 3)) {
    const e = await pub.readContract({ address: book, abi: BOOK_ART.abi, functionName: "entryOf", args: [f.acct] });
    const a = await pub.readContract({ address: f.rawAdapter, abi: AGG_ABI, functionName: "latestRoundData" });
    const match = e[1] === BigInt(a[3]) ? (e[0] === a[1] ? "EXACT" : "MISMATCH!") : "source-advanced";
    checks.push({ feed: f.name, bookAnswer: e[0].toString(), bookPt: e[1].toString(), rawAnswer: a[1].toString(), rawPt: a[3].toString(), match });
    console.log(`  ${f.name.padEnd(12)} book=${e[0]} pt=${e[1]} | raw=${a[1]} pt=${a[3]} → ${match}`);
    if (match === "MISMATCH!") process.exitCode = 1;
}

// ── 4. measured refreshAll runs ─────────────────────────────────────────
async function classify(sig) {
    const [j, b] = await Promise.all([
        sol("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]),
        sol("getTransaction", [sig, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]),
    ]);
    if (!j) return null;
    const msg = j.transaction.message;
    const loaded = j.meta.loadedAddresses ?? { writable: [], readonly: [] };
    const allKeys = [...msg.accountKeys, ...loaded.writable, ...loaded.readonly];
    if (!allKeys.includes(PROGRAM)) return null;
    const rawB64 = b.transaction[0];
    if (!Buffer.from(rawB64, "base64").toString("hex").includes(book.slice(2).toLowerCase())) return null;
    return {
        sig,
        cu: j.meta.computeUnitsConsumed,
        err: j.meta.err,
        totalKeys: allKeys.length,
        size: Buffer.from(rawB64, "base64").length,
        shape: (j.meta.logMessages ?? []).find((l) => l.includes("Instruction:"))?.split("Instruction:")[1]?.trim(),
    };
}

const runs = [];
async function run(label, accts) {
    const anchor = (await sol("getSignaturesForAddress", [anchorPda, { limit: 1, commitment: "confirmed" }]))[0]?.signature;
    const sim = await pub.simulateContract({ address: book, abi: BOOK_ART.abi, functionName: "refreshAll", args: [accts], account });
    const rc = await send(label, () =>
        wallet.writeContract({ address: book, abi: BOOK_ART.abi, functionName: "refreshAll", args: [accts], gasPrice, gas: 30_000_000n, chain: null }),
    );
    const events = { FeedRefreshed: 0, FeedSkippedNotNewer: 0, FeedSkippedPaused: 0, FeedRefreshFailed: 0 };
    for (const log of rc.logs) {
        try {
            const ev = decodeEventLog({ abi: BOOK_ART.abi, data: log.data, topics: log.topics });
            if (ev.eventName in events) events[ev.eventName]++;
        } catch {}
    }
    await sleep(4000);
    const legs = [];
    const params = { limit: 60, commitment: "confirmed" };
    if (anchor) params.until = anchor;
    for (const s of await sol("getSignaturesForAddress", [anchorPda, params])) {
        const c = await classify(s.signature);
        if (c) legs.push(c);
    }
    legs.reverse();
    const totalCU = legs.reduce((a, l) => a + (l.cu ?? 0), 0);
    const r = {
        label,
        width: accts.length,
        simOutcome: sim.result.map(String),
        ethGasUsed: rc.gasUsed.toString(),
        events,
        solanaLegs: legs.length,
        totalCU,
        legs,
    };
    runs.push(r);
    console.log(
        `${label.padEnd(8)} w=${accts.length} C/S/F=${events.FeedRefreshed}/${events.FeedSkippedNotNewer + events.FeedSkippedPaused}/${events.FeedRefreshFailed} ` +
            `legs=${legs.length} CU=${totalCU} keys=${legs[0]?.totalKeys ?? "?"} size=${legs[0]?.size ?? "?"}B ${legs[0]?.shape ?? ""}`,
    );
    return r;
}

const A = registered.map((f) => f.acct);
const WIDTHS = (process.env.WIDTHS ?? "1,2,4,8,all,skip").split(",");
console.log("\nmeasured refreshAll runs (production semantics — sources advance between runs):");
for (const w of WIDTHS) {
    try {
        if (w === "skip") await run("SKIPFAST", A); // right after a full run: cheap-skip path
        else if (w === "all") await run(`W${A.length}`, A);
        else await run(`W${w}`, A.slice(0, Number(w)));
    } catch (e) {
        runs.push({ label: w, error: (e.shortMessage ?? e.message ?? "").split("\n")[0] });
        console.log(`  ${w}: FAILED after retries — recorded, continuing`);
    }
    await sleep(8000); // drain locks/pending between runs
}

writeFileSync(OUT, JSON.stringify({ chainId, book, impl: implAddr, sender: account.address, receiverId: RECEIVER_ID, maxStaleness: MAX_STALENESS.toString(), registered, failed, checks, runs }, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(`\nresults → ${OUT}`);
