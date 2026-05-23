// Full-gamut Solana CU + heap benchmark for every cached-track selector
// shipped in rome-evm-private#376 + #383 against its CPI equivalent
// on HelperProgram / Withdraw, on Hadrian.
//
// Run:
//   npx hardhat run scripts/bench_cached.ts --network hadrian
//
// Conventions:
//   - Bencher EOA = current Hadrian signer (HADRIAN_PRIVATE_KEY)
//   - All tests use the caller's own address where a to/from/spender is
//     needed (self-self is the cleanest apple-to-apple — both cached and
//     cpi paths take the same SPL fast-paths)
//   - Hadrian gas mint (USDC, base58 4zMMC9srt5Ri… / hex 3b442cb3…) is
//     the default mint
//   - Salt-based SystemCached tests use unique salts to avoid state
//     collisions between runs
//   - mint() pair is expected to be rejected pre-send on both tracks:
//     the bencher-PDA is not the on-chain mint authority of the Hadrian
//     gas mint, so SPL Token's process_mint_to correctly rejects. That
//     IS the apple-to-apple result — both tracks hit the same gate
//
// Output: a markdown report at scripts/CACHED_TRACK_BENCH_REPORT.md.

import hardhat from "hardhat";
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";

const HADRIAN_GAS_MINT: `0x${string}` =
    "0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7";
const EVM_RPC = "https://hadrian.testnet.romeprotocol.xyz";
const SOLANA_RPC =
    "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";
const ROME_EVM_PROGRAM = new PublicKey(
    "RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf",
);

interface RowMetric {
    op: string;
    track: "cached" | "cpi" | "cached-only";
    txHash?: string;
    status?: string;
    evmGas?: number;
    solTxSig?: string;
    solCu?: number;
    heapBytes?: number;
    solErr?: string;
    revertReason?: string;
}

async function jsonRpc(url: string, method: string, params: unknown[]) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    return (await res.json()) as { result?: any; error?: any };
}

async function resolveSolanaTx(evmHash: string): Promise<string | undefined> {
    for (let i = 0; i < 15; i++) {
        const r = await jsonRpc(EVM_RPC, "rome_solanaTxForEvmTx", [evmHash]);
        const sigs: string[] = r.result ?? [];
        if (sigs.length > 0) return sigs[0]!;
        await new Promise((s) => setTimeout(s, 1500));
    }
    return undefined;
}

async function resolveReceipt(
    evmHash: string,
): Promise<{ status?: string; gasUsed?: number } | undefined> {
    for (let i = 0; i < 10; i++) {
        const r = await jsonRpc(EVM_RPC, "eth_getTransactionReceipt", [evmHash]);
        if (r.result) {
            return {
                status: r.result.status,
                gasUsed: parseInt(r.result.gasUsed, 16),
            };
        }
        await new Promise((s) => setTimeout(s, 1500));
    }
    return undefined;
}

async function getSolanaMetrics(
    sig: string,
): Promise<{ cu?: number; heapBytes?: number; solErr?: string }> {
    const conn = new Connection(SOLANA_RPC, "confirmed");
    const tx = await conn.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) return {};
    const cu = tx.meta.computeUnitsConsumed;
    const logs = tx.meta.logMessages ?? [];
    let heapBytes: number | undefined;
    for (const l of logs) {
        const m = l.match(/Program log: Heap (\d+)/);
        if (m) {
            heapBytes = parseInt(m[1]!);
            break;
        }
    }
    return {
        cu: cu === null ? undefined : cu,
        heapBytes,
        solErr: tx.meta.err ? JSON.stringify(tx.meta.err) : undefined,
    };
}

async function captureRow(
    op: string,
    track: "cached" | "cpi" | "cached-only",
    call: () => Promise<`0x${string}`>,
): Promise<RowMetric> {
    const row: RowMetric = { op, track };
    try {
        row.txHash = await call();
    } catch (e: any) {
        row.revertReason = String(
            e.shortMessage ?? e.cause?.message ?? e.message ?? e,
        ).slice(0, 200);
        return row;
    }
    const rcpt = await resolveReceipt(row.txHash!);
    if (rcpt) {
        row.status = rcpt.status === "0x1" ? "ok" : "fail";
        row.evmGas = rcpt.gasUsed;
    }
    const solSig = await resolveSolanaTx(row.txHash!);
    if (solSig) {
        row.solTxSig = solSig;
        const m = await getSolanaMetrics(solSig);
        row.solCu = m.cu;
        row.heapBytes = m.heapBytes;
        row.solErr = m.solErr;
    }
    return row;
}

function uniqSalt(seed: number): `0x${string}` {
    // 32-byte salt — use seed in the LSB so each test gets a distinct PDA
    const hex = seed.toString(16).padStart(64, "0");
    return `0x${hex}` as `0x${string}`;
}

async function main() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const me = wallet.account.address;
    console.log("bencher:", me);

    console.log("\n=== Deploying bench_cached ===");
    const c = await viem.deployContract("bench_cached");
    console.log("address:", c.address);

    const rows: RowMetric[] = [];

    // ── SystemCached ─────────────────────────────────────────────
    rows.push(await captureRow("SystemCached.create_pda()", "cached", () => c.write.cached_create_pda()));
    rows.push(await captureRow("SystemCached.create_pda()", "cpi", () => c.write.cpi_create_pda([me])));

    rows.push(await captureRow("SystemCached.create_pda(uint64)", "cached", () => c.write.cached_create_pda_with_lamports([1000000n])));
    rows.push(await captureRow("SystemCached.create_pda(uint64)", "cpi", () => c.write.cpi_create_pda_with_lamports([me, 1000000n])));

    rows.push(await captureRow("SystemCached.create_pda(uint64,bytes32)", "cached-only", () => c.write.cached_create_pda_with_salt([1000000n, uniqSalt(1)])));
    rows.push(await captureRow("SystemCached.create_pda(bytes32,uint64,bytes32)", "cached-only", () => c.write.cached_create_pda_owned([HADRIAN_GAS_MINT, 165n, uniqSalt(2)])));
    rows.push(await captureRow("SystemCached.allocate(uint64,bytes32)", "cached-only", () => c.write.cached_allocate([165n, uniqSalt(3)])));
    rows.push(await captureRow("SystemCached.assign(bytes32,bytes32)", "cached-only", () => c.write.cached_assign([HADRIAN_GAS_MINT, uniqSalt(4)])));

    rows.push(await captureRow("SystemCached.transfer(address,uint64)", "cached", () => c.write.cached_system_transfer([me, 1n])));
    rows.push(await captureRow("SystemCached.transfer(address,uint64)", "cpi", () => c.write.cpi_system_transfer([me, 1n])));

    rows.push(await captureRow("SystemCached.transfer(bytes32,uint64)", "cached-only", () => c.write.cached_system_transfer_b32([HADRIAN_GAS_MINT, 1n])));
    rows.push(await captureRow("SystemCached.transfer(bytes32,uint64,bytes32)", "cached-only", () => c.write.cached_system_transfer_b32_salt([HADRIAN_GAS_MINT, 1n, uniqSalt(5)])));

    // ── SplCached (PR #376 selectors) ─────────────────────────────
    rows.push(await captureRow("SplCached.transfer(address,uint256)", "cached", () => c.write.cached_spl_transfer([me, 1n])));
    rows.push(await captureRow("SplCached.transfer(address,uint256)", "cpi", () => c.write.cpi_spl_transfer([me, 1n])));

    // For bytes32 destinations, use a dummy ATA pubkey — same on both tracks so apple-to-apple holds
    const DUMMY_ATA: `0x${string}` = "0x000000000000000000000000000000000000000000000000000000000000aaaa";
    rows.push(await captureRow("SplCached.transfer(bytes32,uint256)", "cached", () => c.write.cached_spl_transfer_to_pda([DUMMY_ATA, 1n])));
    rows.push(await captureRow("SplCached.transfer(bytes32,uint256)", "cpi", () => c.write.cpi_spl_transfer_to_pda([DUMMY_ATA, 1n])));

    rows.push(await captureRow("SplCached.transfer(address,uint256,bytes32)", "cached", () => c.write.cached_spl_transfer_with_mint([me, 1n, HADRIAN_GAS_MINT])));
    rows.push(await captureRow("SplCached.transfer(address,uint256,bytes32)", "cpi", () => c.write.cpi_spl_transfer_with_mint([me, 1n, HADRIAN_GAS_MINT])));

    rows.push(await captureRow("SplCached.transfer(bytes32,uint256,bytes32)", "cached", () => c.write.cached_spl_transfer_to_pda_with_mint([DUMMY_ATA, 1n, HADRIAN_GAS_MINT])));
    rows.push(await captureRow("SplCached.transfer(bytes32,uint256,bytes32)", "cpi", () => c.write.cpi_spl_transfer_to_pda_with_mint([DUMMY_ATA, 1n, HADRIAN_GAS_MINT])));

    rows.push(await captureRow("SplCached.init(bytes32,bytes32,bytes32)", "cached-only", () => c.write.cached_spl_init([DUMMY_ATA, HADRIAN_GAS_MINT, DUMMY_ATA])));

    // ── SplCached PR #383 selectors ───────────────────────────────
    rows.push(await captureRow("SplCached.transferFrom(address,address,uint256,bytes32) [PR #383]", "cached", () => c.write.cached_transferFrom([me, me, 1n, HADRIAN_GAS_MINT])));
    rows.push(await captureRow("SplCached.transferFrom(address,address,uint256,bytes32) [PR #383]", "cpi", () => c.write.cpi_transferFrom([me, me, 1n, HADRIAN_GAS_MINT])));

    rows.push(await captureRow("SplCached.approve(address,uint256,bytes32) [PR #383]", "cached", () => c.write.cached_approve([me, 1n, HADRIAN_GAS_MINT])));
    rows.push(await captureRow("SplCached.approve(address,uint256,bytes32) [PR #383]", "cpi", () => c.write.cpi_approve([me, 1n, HADRIAN_GAS_MINT])));

    rows.push(await captureRow("SplCached.mint(address,uint256,bytes32) [PR #383]", "cached", () => c.write.cached_mint([me, 1n, HADRIAN_GAS_MINT])));
    rows.push(await captureRow("SplCached.mint(address,uint256,bytes32) [PR #383]", "cpi", () => c.write.cpi_mint([me, 1n, HADRIAN_GAS_MINT])));

    // ── ASplCached (PR #376) ───────────────────────────────────────
    rows.push(await captureRow("ASplCached.create_ata()", "cached", () => c.write.cached_create_ata_self()));
    rows.push(await captureRow("ASplCached.create_ata()", "cpi", () => c.write.cpi_create_ata_self([me])));

    rows.push(await captureRow("ASplCached.create_ata(bytes32)", "cached", () => c.write.cached_create_ata_self_with_mint([HADRIAN_GAS_MINT])));
    rows.push(await captureRow("ASplCached.create_ata(bytes32)", "cpi", () => c.write.cpi_create_ata_for_user_with_mint([me, HADRIAN_GAS_MINT])));

    rows.push(await captureRow("ASplCached.create_ata(address)", "cached", () => c.write.cached_create_ata_for_user([me])));
    rows.push(await captureRow("ASplCached.create_ata(address)", "cpi", () => c.write.cpi_create_ata_self([me])));

    rows.push(await captureRow("ASplCached.create_ata(address,bytes32)", "cached", () => c.write.cached_create_ata_for_user_with_mint([me, HADRIAN_GAS_MINT])));
    rows.push(await captureRow("ASplCached.create_ata(address,bytes32)", "cpi", () => c.write.cpi_create_ata_for_user_with_mint([me, HADRIAN_GAS_MINT])));

    // ── WithdrawCached (PR #376) ───────────────────────────────────
    rows.push(await captureRow("WithdrawCached.withdrawal(bytes32) payable", "cached", () => c.write.cached_withdrawal([HADRIAN_GAS_MINT], { value: 1000000000000n })));
    rows.push(await captureRow("WithdrawCached.withdrawal(bytes32) payable", "cpi", () => c.write.cpi_withdrawal([HADRIAN_GAS_MINT], { value: 1000000000000n })));

    rows.push(await captureRow("WithdrawCached.withdraw_to_pda(uint256)", "cached", () => c.write.cached_withdraw_to_pda([1000000000000n])));
    rows.push(await captureRow("WithdrawCached.withdraw_to_pda(uint256)", "cpi", () => c.write.cpi_withdraw_to_pda([1000000000000n])));

    rows.push(await captureRow("WithdrawCached.withdraw_to_ata(uint256)", "cached", () => c.write.cached_withdraw_to_ata([1000000000000n])));
    rows.push(await captureRow("WithdrawCached.withdraw_to_ata(uint256)", "cpi", () => c.write.cpi_withdraw_to_ata([1000000000000n])));

    // ── WithdrawCached PR #383 ─────────────────────────────────────
    rows.push(await captureRow("WithdrawCached.withdraw_from_ata(uint256) [PR #383]", "cached", () => c.write.cached_withdraw_from_ata([1000000000000n])));
    rows.push(await captureRow("WithdrawCached.withdraw_from_ata(uint256) [PR #383]", "cpi", () => c.write.cpi_deposit_from_ata([1000000000000n])));

    // ── Markdown report ──────────────────────────────────────────
    let md = "";
    const w = (s: string) => { md += s + "\n"; console.log(s); };

    w("\n=== Bench rows ===\n");
    w("| Op | Track | EVM gas | Status | Solana CU | Heap (B) | Solana err / pre-send revert |");
    w("|---|---|---:|---|---:|---:|---|");
    for (const r of rows) {
        const note = r.solErr ? r.solErr.slice(0, 80) : r.revertReason ? r.revertReason.slice(0, 80) : "—";
        const stat = r.status ?? (r.revertReason ? "rejected-pre-send" : "—");
        w(
            "| " + [
                r.op, r.track,
                r.evmGas?.toString() ?? "—",
                stat,
                r.solCu?.toString() ?? "—",
                r.heapBytes?.toString() ?? "—",
                note,
            ].join(" | ") + " |"
        );
    }

    w("\n=== Cached vs cpi delta (Solana CU + heap) ===\n");
    w("| Op | Cached CU | Legacy CU | Δ CU | Δ % | Cached heap | Legacy heap | Δ heap |");
    w("|---|---:|---:|---:|---:|---:|---:|---:|");
    const ops = [...new Set(rows.map(r => r.op))];
    for (const op of ops) {
        const ca = rows.find(r => r.op === op && r.track === "cached");
        const le = rows.find(r => r.op === op && r.track === "cpi");
        if (!ca || !le) continue;
        const cuD = ca.solCu !== undefined && le.solCu !== undefined ? ca.solCu - le.solCu : undefined;
        const cuPct = cuD !== undefined && le.solCu ? `${((cuD / le.solCu) * 100).toFixed(1)}%` : "—";
        const hD = ca.heapBytes !== undefined && le.heapBytes !== undefined ? ca.heapBytes - le.heapBytes : undefined;
        w(
            "| " + [
                op,
                ca.solCu ?? "—", le.solCu ?? "—",
                cuD !== undefined ? (cuD > 0 ? `+${cuD}` : cuD) : "—",
                cuPct,
                ca.heapBytes ?? "—", le.heapBytes ?? "—",
                hD !== undefined ? (hD > 0 ? `+${hD}` : hD) : "—",
            ].join(" | ") + " |"
        );
    }

    fs.writeFileSync(
        "scripts/CACHED_TRACK_BENCH_REPORT_DATA.md",
        md,
    );
    console.log("\n→ scripts/CACHED_TRACK_BENCH_REPORT_DATA.md written\n");
}

main().catch(e => { console.error(e); process.exit(1); });
