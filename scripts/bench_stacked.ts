// Sweeps N-stacked SPL transfers + a heterogeneous add-liquidity-shape
// flow on Hadrian, capturing CU + heap on both cached and CPI tracks at
// each N. Output: a CSV-like table for plotting and a markdown summary
// for the report.
//
// Goal: identify (a) the linear-CU regime, (b) the crossover where one
// track is forced to iterative VM while the other stays atomic, and (c)
// the CU ceiling. The per-step overhead constants extracted here drive
// the projection table for real Romeswap / Compound flows.

import hardhat from "hardhat";
import { Connection } from "@solana/web3.js";

const HADRIAN_GAS_MINT: `0x${string}` =
    "0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7";
const EVM_RPC = "https://hadrian.testnet.romeprotocol.xyz";
const SOLANA_RPC =
    "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";

async function jsonRpc(url: string, method: string, params: unknown[]) {
    const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    return (await r.json()) as { result?: any; error?: any };
}

async function resolveSolanaTxs(evmHash: string): Promise<string[]> {
    let sigs: string[] = [];
    for (let i = 0; i < 15; i++) {
        const r = await jsonRpc(EVM_RPC, "rome_solanaTxForEvmTx", [evmHash]);
        sigs = r.result ?? [];
        if (sigs.length > 0) break;
        await new Promise((s) => setTimeout(s, 1500));
    }
    for (let i = 0; i < 5; i++) {
        await new Promise((s) => setTimeout(s, 1500));
        const r = await jsonRpc(EVM_RPC, "rome_solanaTxForEvmTx", [evmHash]);
        const more: string[] = r.result ?? [];
        if (more.length > sigs.length) sigs = more;
    }
    return sigs;
}

async function getSolanaMetrics(
    sig: string,
): Promise<{ cu?: number; heap?: number; err?: string }> {
    const conn = new Connection(SOLANA_RPC, "confirmed");
    const tx = await conn.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) return {};
    let heap: number | undefined;
    for (const l of tx.meta.logMessages ?? []) {
        const m = l.match(/Program log: Heap (\d+)/);
        if (m) {
            heap = parseInt(m[1]!);
            break;
        }
    }
    return {
        cu: tx.meta.computeUnitsConsumed ?? undefined,
        heap,
        err: tx.meta.err ? JSON.stringify(tx.meta.err) : undefined,
    };
}

interface SweepRow {
    label: string;
    track: "cached" | "cpi";
    n: number;
    sigs?: number;
    cu?: number;
    heap?: number;
    note?: string;
}

async function measure(
    label: string,
    track: "cached" | "cpi",
    n: number,
    call: () => Promise<`0x${string}`>,
): Promise<SweepRow> {
    const row: SweepRow = { label, track, n };
    try {
        const txHash = await call();
        const sigs = await resolveSolanaTxs(txHash);
        row.sigs = sigs.length;
        if (sigs.length > 0) {
            let totalCu = 0;
            let maxHeap = 0;
            let firstErr: string | undefined;
            for (const sig of sigs) {
                const m = await getSolanaMetrics(sig);
                if (m.cu) totalCu += m.cu;
                if (m.heap && m.heap > maxHeap) maxHeap = m.heap;
                if (m.err && !firstErr) firstErr = m.err;
            }
            row.cu = totalCu || undefined;
            row.heap = maxHeap || undefined;
            if (firstErr) row.note = `sol_err=${firstErr}`;
        }
    } catch (e: any) {
        row.note = `revert: ${String(e.shortMessage ?? e.message ?? e).slice(0, 80)}`;
    }
    return row;
}

async function main() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const me = wallet.account.address;
    console.log("bencher:", me);

    console.log("\n=== Deploying bench_stacked ===");
    const c = await viem.deployContract("bench_stacked");
    console.log("address:", c.address);

    const rows: SweepRow[] = [];

    // N-stacked sweep
    const N_VALUES = [1, 2, 3, 5, 8];
    for (const n of N_VALUES) {
        rows.push(
            await measure(`n_self_transfers(${n})`, "cached", n, () =>
                c.write.cached_n_self_transfers([n, me, 1n, HADRIAN_GAS_MINT]),
            ),
        );
        rows.push(
            await measure(`n_self_transfers(${n})`, "cpi", n, () =>
                c.write.cpi_n_self_transfers([n, me, 1n, HADRIAN_GAS_MINT]),
            ),
        );
    }

    // add-liquidity-shape (5 heterogeneous ops)
    // We use the same mint for A=B=LP to keep dispatch simple; the
    // measured CU isolates per-op stacking cost, not pair-routing cost.
    rows.push(
        await measure("add_liquidity_shape", "cached", 5, () =>
            c.write.cached_add_liquidity_shape([
                me, me, 1n, HADRIAN_GAS_MINT, HADRIAN_GAS_MINT, HADRIAN_GAS_MINT,
            ]),
        ),
    );
    rows.push(
        await measure("add_liquidity_shape", "cpi", 5, () =>
            c.write.cpi_add_liquidity_shape([
                me, me, 1n, HADRIAN_GAS_MINT, HADRIAN_GAS_MINT, HADRIAN_GAS_MINT,
            ]),
        ),
    );

    console.log("\n=== Stacked-op sweep ===\n");
    console.log("| Op | Track | N | # Sol txs | Solana CU | CU per step | Heap (B) | Note |");
    console.log("|---|---|---:|---:|---:|---:|---:|---|");
    for (const r of rows) {
        const perStep = r.cu && r.n > 0 ? Math.round(r.cu / r.n) : undefined;
        console.log(
            "| " +
                [
                    r.label,
                    r.track,
                    r.n,
                    r.sigs ?? "—",
                    r.cu ?? "—",
                    perStep ?? "—",
                    r.heap ?? "—",
                    r.note ?? "—",
                ].join(" | ") +
                " |",
        );
    }

    console.log("\n=== Cached vs CPI delta by N ===\n");
    console.log("| Op | N | Cached CU | CPI CU | Δ CU | Δ % | Cached sigs | CPI sigs |");
    console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
    const labels = [...new Set(rows.map((r) => r.label))];
    for (const label of labels) {
        const subset = rows.filter((r) => r.label === label);
        const nValues = [...new Set(subset.map((r) => r.n))].sort((a, b) => a - b);
        for (const n of nValues) {
            const ca = subset.find((r) => r.track === "cached" && r.n === n);
            const cp = subset.find((r) => r.track === "cpi" && r.n === n);
            if (!ca || !cp || !ca.cu || !cp.cu) continue;
            const d = ca.cu - cp.cu;
            const pct = ((d / cp.cu) * 100).toFixed(1);
            console.log(
                "| " +
                    [
                        label,
                        n,
                        ca.cu,
                        cp.cu,
                        d > 0 ? `+${d}` : d,
                        `${pct}%`,
                        ca.sigs,
                        cp.sigs,
                    ].join(" | ") +
                    " |",
            );
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
