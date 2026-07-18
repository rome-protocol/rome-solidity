import hardhat from "hardhat";
import { Connection } from "@solana/web3.js";
import { isAddress, parseAbi, decodeEventLog } from "viem";
import fs from "node:fs";
import { readDeployments } from "../lib/deployments.js";

// Apples-to-apples Solana CU + heap benchmark for SPL_ERC20_cached vs the
// CPI-based SPL_ERC20, both against the SAME deployer-authored test mint
// on Hadrian (so the bencher EOA == on-chain mint authority and the same
// fast-paths fire on both).
//
// Pre-reqs:
//   - HADRIAN_PRIVATE_KEY in keystore (deployer EOA)
//   - Test mint already created via scripts/erc20spl/create_test_mint.ts
//   - SPL_ERC20_cached already deployed against that mint
//     (scripts/erc20spl/deploy_cached.ts, recorded in deployments.SPL_ERC20_cached)
//
// What this script does:
//   1. Deploys a CPI-based SPL_ERC20 against the SAME test mint via
//      factory.add_spl_token_no_metadata (idempotent — reuses existing if
//      already registered)
//   2. Runs the same set of operations on both wrappers:
//        mint_to, transfer, approve, transferFrom, ensure_token_account
//   3. For each op, captures: EVM gas, Solana sig(s), summed Solana CU,
//      peak heap bytes (parsed from `Program heap bytes` log lines)
//   4. Writes a markdown report to scripts/CACHED_VS_CPI_WRAPPER_BENCH.md

const EVM_RPC = "https://hadrian.testnet.romeprotocol.xyz";
const SOLANA_RPC = (process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com");

interface BenchRow {
    op: string;
    track: "cached" | "cpi";
    txHash?: string;
    status?: string;
    evmGas?: number;
    solNumTxs?: number;
    solCu?: number;
    heapBytes?: number;
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

const conn = new Connection(SOLANA_RPC, "confirmed");

async function getSolanaMetrics(
    sig: string,
): Promise<{ cu?: number; heapBytes?: number }> {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) return {};
    const cu = tx.meta.computeUnitsConsumed ?? 0;
    let heapBytes = 0;
    for (const log of tx.meta.logMessages ?? []) {
        // Rome program emits `Program log: Heap <bytes>` once per tx
        // after the EVM frame commits. Capture the max across segments.
        const m = log.match(/^Program log:\s*Heap\s+(\d+)/);
        if (m) {
            const v = parseInt(m[1], 10);
            if (!Number.isNaN(v) && v > heapBytes) heapBytes = v;
        }
    }
    return { cu, heapBytes };
}

async function captureRow(
    op: string,
    track: "cached" | "cpi",
    send: () => Promise<`0x${string}`>,
): Promise<BenchRow> {
    process.stdout.write(`  ${op} [${track}]... `);
    const row: BenchRow = { op, track };
    try {
        const hash = await send();
        row.txHash = hash;
        // Retry receipt — the EVM tx may need a few polls before it's mined.
        for (let i = 0; i < 10; i++) {
            const r = await jsonRpc(EVM_RPC, "eth_getTransactionReceipt", [hash]);
            if (r.result) {
                row.status = r.result.status === "0x1" ? "success" : "reverted";
                row.evmGas = parseInt(r.result.gasUsed, 16);
                break;
            }
            await new Promise((s) => setTimeout(s, 1500));
        }
        const sigs = await resolveSolanaTxs(hash);
        row.solNumTxs = sigs.length;
        let cuTotal = 0;
        let heapMax = 0;
        for (const sig of sigs) {
            const m = await getSolanaMetrics(sig);
            cuTotal += m.cu ?? 0;
            if ((m.heapBytes ?? 0) > heapMax) heapMax = m.heapBytes!;
        }
        row.solCu = cuTotal;
        row.heapBytes = heapMax;
        console.log(
            `${row.status} | evm ${row.evmGas} | sol ${row.solNumTxs} tx | cu ${row.solCu} | heap ${row.heapBytes}`,
        );
    } catch (e: any) {
        row.status = "exception";
        row.revertReason = String(e?.message ?? e).slice(0, 200);
        console.log(`EXCEPTION: ${row.revertReason}`);
    }
    return row;
}

async function main() {
    const networkName = process.env.HARDHAT_NETWORK ?? "hadrian";
    const dep = readDeployments(networkName);

    const cachedAddress = dep.SPL_ERC20_cached?.address as `0x${string}` | undefined;
    const cachedMint = dep.SPL_ERC20_cached?.mint as `0x${string}` | undefined;
    if (!cachedAddress || !isAddress(cachedAddress) || !cachedMint) {
        throw new Error("SPL_ERC20_cached not found in deployments. Run create_test_mint.ts + deploy_cached.ts first.");
    }
    const factoryAddress = dep.ERC20SPLFactory?.address as `0x${string}` | undefined;
    if (!factoryAddress || !isAddress(factoryAddress)) {
        throw new Error("ERC20SPLFactory not deployed.");
    }

    const { viem } = await hardhat.network.connect();
    const publicClient = await viem.getPublicClient();
    const wallets = await viem.getWalletClients();
    const wallet = wallets[0];
    const me = wallet.account.address;

    // 1. Ensure a CPI-based SPL_ERC20 exists for the SAME test mint
    const factoryAbi = parseAbi([
        "function token_by_mint(bytes32) external view returns (address)",
        "function add_spl_token_no_metadata(bytes32 mint, string name, string symbol) external returns (address)",
    ]);
    let cpiAddress = (await publicClient.readContract({
        address: factoryAddress,
        abi: factoryAbi,
        functionName: "token_by_mint",
        args: [cachedMint],
    })) as `0x${string}`;
    if (cpiAddress === "0x0000000000000000000000000000000000000000") {
        console.log("Registering test mint with factory (deploys CPI-based SPL_ERC20)...");
        const txHash = await wallet.writeContract({
            address: factoryAddress,
            abi: factoryAbi,
            functionName: "add_spl_token_no_metadata",
            args: [cachedMint, "CPI Test Token", "wTESTcpi"],
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        cpiAddress = (await publicClient.readContract({
            address: factoryAddress,
            abi: factoryAbi,
            functionName: "token_by_mint",
            args: [cachedMint],
        })) as `0x${string}`;
    }
    console.log(`  cached wrapper: ${cachedAddress}`);
    console.log(`  cpi    wrapper: ${cpiAddress}`);
    console.log(`  shared mint:   ${cachedMint}`);
    console.log("");

    // 2. ABI for both wrappers — identical IERC20 + IERC20Metadata surface
    const wrapperAbi = parseAbi([
        "function mint_to(address to, uint256 value) external returns (bool)",
        "function transfer(address to, uint256 value) external returns (bool)",
        "function approve(address spender, uint256 value) external returns (bool)",
        "function transferFrom(address from, address to, uint256 value) external returns (bool)",
        "function ensure_token_account(address user) external returns (bytes32)",
    ]);

    // 3. Drive the same ops on both wrappers + collect rows
    const rows: BenchRow[] = [];
    const recip = "0x000000000000000000000000000000000000c0de" as `0x${string}`;
    const recip2 = "0x000000000000000000000000000000000000babe" as `0x${string}`;

    const send = (wrap: `0x${string}`, fn: string, args: any[]) =>
        wallet.writeContract({
            address: wrap,
            abi: wrapperAbi,
            functionName: fn as any,
            args: args as any,
        });

    // Warm both wrappers' recipient ATAs (separate ATA creation cost from
    // mutation cost — first transfer to a fresh address pays for the ATA).
    console.log("=== Warm-up: ensure_token_account (one-shot ATA create) ===");
    rows.push(await captureRow("ensure_token_account(recipient)", "cached", () => send(cachedAddress, "ensure_token_account", [recip])));
    rows.push(await captureRow("ensure_token_account(recipient)", "cpi",    () => send(cpiAddress,    "ensure_token_account", [recip])));

    console.log("\n=== mint_to ===");
    rows.push(await captureRow("mint_to(recipient, 1_000_000)", "cached", () => send(cachedAddress, "mint_to", [recip, 1_000_000n])));
    rows.push(await captureRow("mint_to(recipient, 1_000_000)", "cpi",    () => send(cpiAddress,    "mint_to", [recip, 1_000_000n])));

    console.log("\n=== transfer (sender owns balance, recipient ATA exists) ===");
    // Pre-mint to sender on both wrappers so transfer has balance
    await send(cachedAddress, "mint_to", [me, 10_000_000n]).then((h) => publicClient.waitForTransactionReceipt({ hash: h }));
    await send(cpiAddress,    "mint_to", [me, 10_000_000n]).then((h) => publicClient.waitForTransactionReceipt({ hash: h }));
    // Warm recip2 ATAs so transfer doesn't include ATA-create cost
    await send(cachedAddress, "ensure_token_account", [recip2]).then((h) => publicClient.waitForTransactionReceipt({ hash: h }));
    await send(cpiAddress,    "ensure_token_account", [recip2]).then((h) => publicClient.waitForTransactionReceipt({ hash: h }));
    rows.push(await captureRow("transfer(recip2, 100_000)", "cached", () => send(cachedAddress, "transfer", [recip2, 100_000n])));
    rows.push(await captureRow("transfer(recip2, 100_000)", "cpi",    () => send(cpiAddress,    "transfer", [recip2, 100_000n])));

    console.log("\n=== approve ===");
    rows.push(await captureRow("approve(spender, 500_000)", "cached", () => send(cachedAddress, "approve", [recip, 500_000n])));
    rows.push(await captureRow("approve(spender, 500_000)", "cpi",    () => send(cpiAddress,    "approve", [recip, 500_000n])));

    console.log("\n=== transferFrom (caller-as-delegate path) ===");
    // Self-as-spender works because approve(me, X) sets external_auth(me) as
    // delegate on me's own ATA; transferFrom(me, recip2, ...) signed by me
    // passes the SPL delegate check.
    await send(cachedAddress, "approve", [me, 500_000n]).then((h) => publicClient.waitForTransactionReceipt({ hash: h }));
    await send(cpiAddress,    "approve", [me, 500_000n]).then((h) => publicClient.waitForTransactionReceipt({ hash: h }));
    rows.push(await captureRow("transferFrom(me, recip2, 50_000)", "cached", () => send(cachedAddress, "transferFrom", [me, recip2, 50_000n])));
    rows.push(await captureRow("transferFrom(me, recip2, 50_000)", "cpi",    () => send(cpiAddress,    "transferFrom", [me, recip2, 50_000n])));

    // 4. Markdown report
    const lines: string[] = [];
    lines.push("# SPL_ERC20_cached vs CPI-based SPL_ERC20 — wrapper-level Solana CU + heap");
    lines.push("");
    lines.push("Apples-to-apples comparison on Hadrian. Same deployer-authored test mint, same operations.");
    lines.push("");
    lines.push(`- cached wrapper: \`${cachedAddress}\``);
    lines.push(`- cpi    wrapper: \`${cpiAddress}\``);
    lines.push(`- shared mint:   \`${cachedMint}\``);
    lines.push("");
    lines.push("| Operation | Track | Status | EVM gas | Sol txs | Sol CU | Heap bytes |");
    lines.push("|---|---|---|---:|---:|---:|---:|");
    for (const r of rows) {
        lines.push(
            `| ${r.op} | ${r.track} | ${r.status ?? ""} | ${r.evmGas ?? ""} | ${r.solNumTxs ?? ""} | ${r.solCu ?? ""} | ${r.heapBytes ?? ""} |`,
        );
    }
    lines.push("");

    // Side-by-side delta summary
    lines.push("## Delta (cached − cpi, negative = cached saves)");
    lines.push("");
    lines.push("| Operation | EVM gas Δ | Sol CU Δ | Heap Δ |");
    lines.push("|---|---:|---:|---:|");
    const byOp = new Map<string, { cached?: BenchRow; cpi?: BenchRow }>();
    for (const r of rows) {
        const entry = byOp.get(r.op) ?? {};
        if (r.track === "cached") entry.cached = r;
        else entry.cpi = r;
        byOp.set(r.op, entry);
    }
    for (const [op, { cached, cpi }] of byOp.entries()) {
        if (!cached || !cpi) continue;
        const gasDelta = (cached.evmGas ?? 0) - (cpi.evmGas ?? 0);
        const cuDelta = (cached.solCu ?? 0) - (cpi.solCu ?? 0);
        const heapDelta = (cached.heapBytes ?? 0) - (cpi.heapBytes ?? 0);
        lines.push(`| ${op} | ${gasDelta} | ${cuDelta} | ${heapDelta} |`);
    }

    const out = "scripts/CACHED_VS_CPI_WRAPPER_BENCH.md";
    fs.writeFileSync(out, lines.join("\n") + "\n");
    console.log(`\nReport written to ${out}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
