#!/usr/bin/env node
/**
 * PriceBook Phase-0 triage — measures refreshAll() capacity on a LIVE Rome
 * chain from on-chain receipts (never from architecture): Solana compute
 * units, account metas, serialized tx size, and whether the proxy kept each
 * width atomic. Protocol:
 *
 *   INIT      refreshAll(8, force=false)  first-write storage creation (labeled, excluded from marginals)
 *   W1/2/4/8  refreshAll(w, force=true)   steady-state commit path at each width
 *   SKIP8     refreshAll(8, force=false)  the all-skip (nothing newer) path
 *   FAULT     refreshAll([bogus]+7, true) one faulted feed inside a surviving batch
 *
 * Attribution: after each EVM tx, new Solana signatures touching feed[0]'s
 * account (anchored with `until`) are classified by whether the raw tx bytes
 * contain the probe address (ours) vs a known adapter address (keeper's).
 *
 * Env (all endpoints/keys injected, nothing baked in):
 *   RPC               Rome EVM JSON-RPC                  (required)
 *   SOLANA_RPC        Solana RPC for receipt reads       (required)
 *   EVM_KEY_FILE      path to 0x-hex private key file    (required; key never printed)
 *   FEEDS_JSON        registry-style oracle.json         (required)
 *   ROME_EVM_PROGRAM  base58 program id                  (required)
 *   PROBE             pre-deployed probe address         (optional; skips deploy)
 *   OUT               JSON results path                  (optional)
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
const OUT = process.env.OUT ?? "pricebook-triage-results.json";

const ART = JSON.parse(
    readFileSync(new URL("../../artifacts/contracts/oracle/test/PriceBookProbe.sol/PriceBookProbe.json", import.meta.url)),
);
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
const pythFeeds = Object.entries(reg.feeds)
    .filter(([, f]) => f.source === "pyth")
    .map(([name, f]) => ({ name, adapter: f.address, pda: f.underlyingAccount, acct: b58ToBytes32(f.underlyingAccount) }));
const sbFeed = Object.values(reg.feeds).find((f) => f.source === "switchboard");
if (pythFeeds.length < 8) throw new Error(`need ≥8 pyth feeds, got ${pythFeeds.length}`);
const FEEDS = pythFeeds.slice(0, 8);
const anchorPda = FEEDS[0].pda; // every run includes feed[0]

const account = privateKeyToAccount(readFileSync(KEY_FILE, "utf8").trim());
const pub = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account, transport: http(RPC) });
const gasPrice = await pub.getGasPrice(); // legacy sends: feeHistory is stubbed on Rome proxies
const chainId = await pub.getChainId();
console.log(`chain ${chainId} · sender ${account.address} · gasPrice ${gasPrice} · ${FEEDS.length} pyth feeds`);

// ── deploy (or reuse) ───────────────────────────────────────────────────
let probe = process.env.PROBE;
if (!probe) {
    const hash = await wallet.deployContract({ abi: ART.abi, bytecode: ART.bytecode, args: [], gasPrice, chain: null });
    console.log(`deploy tx ${hash}`);
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
    if (rc.status !== "success") throw new Error("deploy failed");
    probe = rc.contractAddress;
}
console.log(`probe ${probe}`);
const probeHex = probe.slice(2).toLowerCase();
const adapterHexes = pythFeeds.map((f) => f.adapter.slice(2).toLowerCase());

// ── solana attribution ──────────────────────────────────────────────────
async function newSigsSince(untilSig, t0, t1) {
    const params = { limit: 100, commitment: "confirmed" };
    if (untilSig) params.until = untilSig;
    const sigs = await sol("getSignaturesForAddress", [anchorPda, params]);
    return sigs.filter((s) => !s.blockTime || (s.blockTime >= t0 - 60 && s.blockTime <= t1 + 60));
}
async function classify(sig) {
    const [j, b] = await Promise.all([
        sol("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]),
        sol("getTransaction", [sig, { encoding: "base64", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]),
    ]);
    if (!j) return null;
    const msg = j.transaction.message;
    const loaded = j.meta.loadedAddresses ?? { writable: [], readonly: [] };
    const allKeys = [...msg.accountKeys, ...loaded.writable, ...loaded.readonly];
    if (!allKeys.includes(PROGRAM)) return null; // not a rome-evm execution
    const rawB64 = b.transaction[0];
    const rawHex = Buffer.from(rawB64, "base64").toString("hex");
    const size = Buffer.from(rawB64, "base64").length;
    const owner = rawHex.includes(probeHex) ? "probe" : adapterHexes.some((a) => rawHex.includes(a)) ? "keeper" : "other";
    const cuLog = (j.meta.logMessages ?? []).filter((l) => l.includes("consumed") && l.includes(PROGRAM));
    return {
        sig,
        owner,
        blockTime: j.blockTime,
        cu: j.meta.computeUnitsConsumed,
        fee: j.meta.fee,
        err: j.meta.err,
        staticKeys: msg.accountKeys.length,
        loadedKeys: loaded.writable.length + loaded.readonly.length,
        totalKeys: allKeys.length,
        altLookups: (msg.addressTableLookups ?? []).length,
        size,
        cuLog,
    };
}

// ── one measured run ────────────────────────────────────────────────────
const runs = [];
async function run(label, accts, force) {
    const anchor = (await sol("getSignaturesForAddress", [anchorPda, { limit: 1, commitment: "confirmed" }]))[0]?.signature;
    const t0 = Math.floor(Date.now() / 1000);
    const gas = await pub.estimateContractGas({ address: probe, abi: ART.abi, functionName: "refreshAll", args: [accts, force], account });
    const hash = await wallet.writeContract({
        address: probe,
        abi: ART.abi,
        functionName: "refreshAll",
        args: [accts, force],
        gas: (gas * 15n) / 10n,
        gasPrice,
        chain: null,
    });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
    const t1 = Math.floor(Date.now() / 1000);
    const events = { FeedRefreshed: 0, FeedSkippedNotNewer: 0, FeedRefreshFailed: 0 };
    for (const log of rc.logs) {
        try {
            const ev = decodeEventLog({ abi: ART.abi, data: log.data, topics: log.topics });
            if (ev.eventName in events) events[ev.eventName]++;
        } catch {}
    }
    await sleep(4000); // let confirmations/index settle before attribution
    const legs = [];
    for (const s of await newSigsSince(anchor, t0, t1)) {
        const c = await classify(s.signature);
        if (c && c.owner === "probe") legs.push(c);
    }
    legs.reverse(); // chronological
    const totalCU = legs.reduce((a, l) => a + (l.cu ?? 0), 0);
    const r = {
        label,
        width: accts.length,
        force,
        ethTx: hash,
        ethGasUsed: rc.gasUsed.toString(),
        ethStatus: rc.status,
        events,
        solanaLegs: legs.length,
        totalCU,
        legs,
    };
    runs.push(r);
    console.log(
        `${label.padEnd(6)} w=${accts.length} eth=${rc.status} gasUsed=${rc.gasUsed} ` +
            `C/S/F=${events.FeedRefreshed}/${events.FeedSkippedNotNewer}/${events.FeedRefreshFailed} ` +
            `legs=${legs.length} CU=${totalCU} keys=${legs[0]?.totalKeys ?? "?"} size=${legs[0]?.size ?? "?"}B`,
    );
    return r;
}

// ── protocol ────────────────────────────────────────────────────────────
const A = FEEDS.map((f) => f.acct);
await run("INIT", A, false);
await run("W1", A.slice(0, 1), true);
await run("W2", A.slice(0, 2), true);
await run("W4", A.slice(0, 4), true);
await run("W8", A, true);
await run("SKIP8", A, false);
const bogus = process.env.FAULT_ACCOUNT ?? sbFeed?.underlyingAccount;
if (bogus) await run("FAULT", [b58ToBytes32(bogus), ...A.slice(0, 7)], true);

// ── cross-check: probe entries vs live raw adapters ─────────────────────
console.log("\ncross-check vs deployed raw adapters:");
const checks = [];
for (const f of FEEDS.slice(0, 3)) {
    const e = await pub.readContract({ address: probe, abi: ART.abi, functionName: "entries", args: [f.acct] });
    const a = await pub.readContract({ address: f.adapter, abi: AGG_ABI, functionName: "latestRoundData" });
    const match = e[2] === BigInt(a[3]) ? (e[0] === a[1] ? "EXACT" : "MISMATCH!") : "source-advanced";
    checks.push({ feed: f.name, probeAnswer: e[0].toString(), probePt: e[2].toString(), adapterAnswer: a[1].toString(), adapterPt: a[3].toString(), match });
    console.log(`  ${f.name.padEnd(12)} probe=${e[0]} pt=${e[2]} | adapter=${a[1]} pt=${a[3]} → ${match}`);
    if (match === "MISMATCH!") process.exitCode = 1;
}

// ── marginal fit (steady-state widths only) ─────────────────────────────
const w = Object.fromEntries(runs.filter((r) => /^W\d$/.test(r.label)).map((r) => [r.width, r]));
let summary = {};
if (w[1] && w[8] && w[1].solanaLegs === 1 && w[8].solanaLegs === 1) {
    const marginal = Math.round((w[8].totalCU - w[1].totalCU) / 7);
    const fixed = w[1].totalCU - marginal;
    summary = { fixedCU: fixed, marginalCUPerFeed: marginal, atomic8: w[8].totalCU, headroomTo1M4: 1_400_000 - w[8].totalCU };
    console.log(`\nfixed≈${fixed} CU · marginal≈${marginal} CU/feed · 8-wide=${w[8].totalCU} CU (headroom to 1.4M: ${summary.headroomTo1M4})`);
} else {
    console.log("\n8-wide did not land as a single atomic leg — see per-run legs for the real tx count");
}

writeFileSync(OUT, JSON.stringify({ chainId, probe, sender: account.address, feeds: FEEDS, runs, checks, summary }, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(`\nresults → ${OUT}`);
