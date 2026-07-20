// Validation script for the suspect WithdrawCached.deposit bench rows
// (cached @ 11171 CU vs CPI @ ~124K CU). Originally `withdraw_from_ata`,
// renamed in a Rome EVM program upgrade (selector `0x214ee485` → `0xb6b55f25`).
// Hypothesis: the cached track was short-circuiting because the EOA's
// wUSDC balance was consumed by an earlier success-path call.
//
// What this does:
//   1. Reads caller-PDA + wUSDC ATA from on-chain
//   2. If wUSDC balance is 0, tops up by calling withdraw_to_ata (wraps
//      native gas → wUSDC SPL in caller's PDA-ATA) so balance is non-zero
//   3. Re-fires cached_deposit + cpi_deposit_from_ata against the
//      existing deployed bench_cached
//   4. Pulls full Solana logs for both — exposes whether the cached
//      track took the heavy path or short-circuited
//   5. Reports apple-to-apple cost.

import hardhat from "hardhat";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const HADRIAN_GAS_MINT: `0x${string}` =
    "0x3b442cb3912157f13a933d0134282d032b5ffecd01a2dbf1b7790608df002ea7";
const EVM_RPC = "https://hadrian.testnet.romeprotocol.xyz";
const SOLANA_RPC =
    (process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com");
const HELPER = "0xff00000000000000000000000000000000000009";
const WITHDRAW_LEGACY = "0x4200000000000000000000000000000000000016";

// Pass an existing bench contract address as env, else deploy a fresh one.
const BENCH_ADDR = process.env.BENCH_ADDR;

async function jsonRpc(url: string, method: string, params: unknown[]) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    return (await res.json()) as { result?: any; error?: any };
}

function hexToBase58(hex32: string): string {
    const buf = Buffer.from(hex32.replace(/^0x/, ""), "hex");
    return bs58.encode(buf);
}

async function getAtaBalanceFromChain(ataBase58: string): Promise<bigint> {
    const conn = new Connection(SOLANA_RPC, "confirmed");
    const acc = await conn.getAccountInfo(new PublicKey(ataBase58));
    if (!acc) return 0n;
    if (acc.data.length < 72) return 0n;
    return acc.data.readBigUInt64LE(64); // SPL Token amount offset
}

async function pullSolanaLog(sig: string): Promise<string[]> {
    const conn = new Connection(SOLANA_RPC, "confirmed");
    const tx = await conn.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
    });
    return tx?.meta?.logMessages ?? [];
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

async function getSolanaCu(sig: string): Promise<{ cu?: number; heap?: number }> {
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
    return { cu: tx.meta.computeUnitsConsumed ?? undefined, heap };
}

async function main() {
    const { viem } = await hardhat.network.connect();
    const [wallet] = await viem.getWalletClients();
    const me = wallet.account.address;
    const publicClient = await viem.getPublicClient();
    console.log("bencher:", me);

    // ── Step 1: read caller-PDA + wUSDC ATA ──────────────────────
    // HelperProgram.ata(address, bytes32) selector 0xfeb1c647
    const ataData =
        "0xfeb1c647" +
        me.slice(2).padStart(64, "0") +
        HADRIAN_GAS_MINT.slice(2);
    const ataResp = await jsonRpc(EVM_RPC, "eth_call", [
        { to: HELPER, data: ataData },
        "latest",
    ]);
    const wUsdcAta = "0x" + ataResp.result.slice(2).padStart(64, "0").slice(-64);
    const wUsdcAtaB58 = hexToBase58(wUsdcAta);
    console.log("wUSDC ATA (hex):", wUsdcAta);
    console.log("wUSDC ATA (b58):", wUsdcAtaB58);

    const balBefore = await getAtaBalanceFromChain(wUsdcAtaB58);
    console.log("wUSDC ATA balance (before):", balBefore);

    // ── Step 2: top up if needed ─────────────────────────────────
    let bench;
    if (BENCH_ADDR) {
        bench = await viem.getContractAt("bench_cached", BENCH_ADDR as `0x${string}`);
        console.log("Re-using existing bench_cached at", BENCH_ADDR);
    } else {
        console.log("\n=== Deploying fresh bench_cached ===");
        bench = await viem.deployContract("bench_cached");
        console.log("address:", bench.address);
    }

    if (balBefore < 2n * 1000000n) {
        // Need at least 2 wUSDC (6 decimals) — top up by wrapping 2 USDC of native gas
        console.log("\n→ Topping up wUSDC ATA via cpi_withdraw_to_ata(2*10^18 wei = 2 wUSDC)");
        const wrapHash = await bench.write.cpi_withdraw_to_ata([2000000000000000000n]);
        await publicClient.waitForTransactionReceipt({ hash: wrapHash });
        const balAfterWrap = await getAtaBalanceFromChain(wUsdcAtaB58);
        console.log("wUSDC ATA balance (after wrap):", balAfterWrap);
        if (balAfterWrap === balBefore) {
            console.log("⚠ Wrap didn't change balance — caller probably doesn't have native gas to wrap. Aborting.");
            return;
        }
    }

    // ── Step 3: fire both unwrap paths ───────────────────────────
    // Use 1 wUSDC worth (10^18 wei) — well within balance now
    const WEI_PER_WUSDC = 1000000000000000000n;

    async function resolveAllSolanaSigs(
        evmHash: string,
    ): Promise<string[]> {
        // Iterative EVM tx spans multiple Solana txs — return ALL of them.
        // Retry until at least one is indexed, then give Hercules a moment
        // to register the rest.
        let sigs: string[] = [];
        for (let i = 0; i < 15; i++) {
            const r = await jsonRpc(EVM_RPC, "rome_solanaTxForEvmTx", [
                evmHash,
            ]);
            sigs = r.result ?? [];
            if (sigs.length > 0) break;
            await new Promise((s) => setTimeout(s, 1500));
        }
        // Re-poll briefly in case the iterative flow is still being
        // indexed after the first sig appears.
        for (let i = 0; i < 5; i++) {
            await new Promise((s) => setTimeout(s, 1500));
            const r = await jsonRpc(EVM_RPC, "rome_solanaTxForEvmTx", [
                evmHash,
            ]);
            const more: string[] = r.result ?? [];
            if (more.length > sigs.length) sigs = more;
        }
        return sigs;
    }

    async function runAndProbe(
        label: string,
        call: () => Promise<`0x${string}`>,
    ) {
        console.log(`\n── ${label} ──`);
        let txHash: `0x${string}`;
        try {
            txHash = await call();
        } catch (e: any) {
            console.log(
                "  THROW:",
                String(e.shortMessage ?? e.message ?? e).slice(0, 200),
            );
            return;
        }
        console.log("  EVM tx:", txHash);
        const sigs = await resolveAllSolanaSigs(txHash);
        if (sigs.length === 0) {
            console.log("  No Solana sigs resolved");
            return;
        }
        console.log(`  ${sigs.length} Solana sig(s):`);
        let totalCu = 0;
        let maxHeap = 0;
        for (const sig of sigs) {
            const { cu, heap } = await getSolanaCu(sig);
            console.log(`    ${sig.slice(0, 20)}…  CU=${cu}  Heap=${heap}B`);
            if (cu) totalCu += cu;
            if (heap && heap > maxHeap) maxHeap = heap;
        }
        console.log(
            `  TOTAL CU across all segments: ${totalCu}  (max heap: ${maxHeap}B)`,
        );
        // Dump logs from the LAST sig (where the real work usually lands)
        const lastSig = sigs[sigs.length - 1]!;
        const logs = await pullSolanaLog(lastSig);
        console.log(`  Logs from final segment ${lastSig.slice(0, 20)}…:`);
        for (const l of logs) {
            if (
                /Program (RPTW|Tokenkeg|1111)|Program log|consumed|invoke \[/.test(
                    l,
                )
            ) {
                console.log("    ", l);
            }
        }
    }

    await runAndProbe("CACHED  deposit(1e18 wei)", () =>
        bench.write.cached_deposit([WEI_PER_WUSDC]),
    );
    await runAndProbe("CPI     deposit_from_ata(1e18 wei)", () =>
        bench.write.cpi_deposit_from_ata([WEI_PER_WUSDC]),
    );

    const balAfter = await getAtaBalanceFromChain(wUsdcAtaB58);
    console.log("\nwUSDC ATA balance (after both unwraps):", balAfter);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
