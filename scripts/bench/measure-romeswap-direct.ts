/**
 * Hypothesis: can `RomeswapDirect.addLiq` fit in 1 Solana tx?
 *
 * The Rome-required 3-tx addLiquidity breakdown comes from router overhead
 * (slippage, optimal-amounts, path math) busting 1.4M CU. With a minimal
 * direct router that takes pre-computed amounts and just does
 * transferFrom x2 + pair.mint inline, the per-op cost should be:
 *   ~262K (wrapper.transferFrom) x 2 + ~300K (pair.mint) + envelope
 *   = ~830K-900K CU. Should fit.
 *
 * This script deploys RomeswapDirect, sets allowances, pre-inits Pair A
 * with a seed mint (not counted as sample), then runs 3 single-tx addLiq
 * samples. If addLiq fits, also benches swap + removeLiq.
 *
 * Output: deployments/hadrian.romeswap-direct.results.json
 */
import fs from "node:fs";
import {
    Wallet, JsonRpcProvider, Contract, Interface, ContractFactory, getAddress,
} from "ethers";
import directArtifact from "../../artifacts/contracts/cpi/test/RomeswapDirect.sol/RomeswapDirect.json" with { type: "json" };

const HELPER_PROGRAM = "0xff00000000000000000000000000000000000009";
const SOLANA_RPC = "https://api.devnet.solana.com/";
const HADRIAN_RPC = "https://hadrian.testnet.romeprotocol.xyz/";
const SAMPLES = 3;

const V1_WUSDC = "0x94AC3E5e998d72088045853C1CfB910F6CE90E56";
const PAIR_A = "0x45350dF36fA7334C2E267598Af8fC136e4982A9E"; // wUSDC x wBench

const helperIface = new Interface([
    "function swap_gas_to_lamports(uint64 lamports) external",
    "function transfer_lamports(address to, uint64 lamports) external",
]);
const erc20Iface = new Interface([
    "function transfer(address to, uint256 amount) external returns (bool)",
    "function transferFrom(address from, address to, uint256 amount) external returns (bool)",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function balanceOf(address) external view returns (uint256)",
    "function allowance(address owner, address spender) external view returns (uint256)",
]);
const pairIface = new Interface([
    "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() external view returns (address)",
    "function balanceOf(address) external view returns (uint256)",
    "function totalSupply() external view returns (uint256)",
]);

async function romeSig(h: string): Promise<string[]> {
    const r = await fetch(HADRIAN_RPC, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rome_solanaTxForEvmTx", params: [h] }) });
    return ((await r.json()) as any).result ?? [];
}
async function solCu(sig: string): Promise<number> {
    const r = await fetch(SOLANA_RPC, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction",
            params: [sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }) });
    return ((await r.json()) as any).result?.meta?.computeUnitsConsumed ?? 0;
}
async function totalCu(h: string) {
    let sigs: string[] = [];
    for (let i = 0; i < 30; i++) { sigs = await romeSig(h); if (sigs.length) break; await new Promise(r => setTimeout(r, 2000)); }
    if (!sigs.length) throw new Error(`empty sigs for ${h}`);
    const per: number[] = [];
    for (const s of sigs) {
        let cu = 0;
        for (let i = 0; i < 10; i++) { cu = await solCu(s); if (cu > 0) break; await new Promise(r => setTimeout(r, 1500)); }
        per.push(cu);
    }
    return { sigs, perTx: per, totalCu: per.reduce((a, b) => a + b, 0) };
}

interface Op { label: string; samples: any[]; mean: number | "n/a" }
async function run(label: string, fn: (i: number) => Promise<string>): Promise<Op> {
    console.log(`\nProbing: ${label}`);
    const sm: any[] = [];
    for (let i = 0; i < SAMPLES; i++) {
        try {
            const h = await fn(i);
            const { sigs, perTx, totalCu: cu } = await totalCu(h);
            console.log(`  ${i+1}/${SAMPLES}: ${h.slice(0,12)}... sigs=${sigs.length} cu=${cu.toLocaleString()}`);
            sm.push({ evmHash: h, sigs, perTx, totalCu: cu });
        } catch (e: any) {
            const m = (e.message || String(e)).slice(0, 250);
            console.log(`  ${i+1}/${SAMPLES}: ERROR ${m}`);
            sm.push({ evmHash: "0x", sigs: [], perTx: [], totalCu: 0, error: m });
        }
    }
    const v = sm.filter(s => s.totalCu > 0);
    const mean = v.length ? Math.round(v.reduce((a, b) => a + b.totalCu, 0) / v.length) : ("n/a" as const);
    return { label, samples: sm, mean };
}

async function main() {
    const provider = new JsonRpcProvider(HADRIAN_RPC);
    const pk = process.env.HARDHAT_VAR_HADRIAN_PRIVATE_KEY;
    if (!pk) throw new Error("Missing HARDHAT_VAR_HADRIAN_PRIVATE_KEY");
    const wallet = new Wallet(pk, provider);
    console.log(`Deployer: ${wallet.address}`);

    const v2Art = JSON.parse(fs.readFileSync("deployments/hadrian.real-flow-bench.json", "utf8"));
    const V2_WBENCH = v2Art.v2.SPL_ERC20_wBench;
    console.log(`Pair A:   ${PAIR_A} (wUSDC x wBench)`);
    console.log(`wUSDC:    ${V1_WUSDC}`);
    console.log(`wBench:   ${V2_WBENCH}`);

    // ─── Setup: top up PDA lamports ──────────────────────────────────────
    console.log("\n[setup] Top up PDA lamports (10M)...");
    try {
        await (await wallet.sendTransaction({ to: HELPER_PROGRAM,
            data: helperIface.encodeFunctionData("swap_gas_to_lamports", [10_000_000n]),
            gasLimit: 15_000_000n })).wait();
    } catch (e: any) { console.log(`  skip: ${e.message?.slice(0,100)}`); }

    // ─── Deploy RomeswapDirect ───────────────────────────────────────────
    console.log("\n[deploy] RomeswapDirect...");
    const factory = new ContractFactory(directArtifact.abi, directArtifact.bytecode, wallet);
    const direct = await factory.deploy();
    await direct.waitForDeployment();
    const directAddr = await direct.getAddress();
    console.log(`        RomeswapDirect: ${directAddr}`);

    const directContract = new Contract(directAddr, directArtifact.abi, wallet);

    // ─── Top up directContract's PDA — caller pays for auto-ATA-create rent ─
    // Each pair the contract touches needs ~5M lamports for the bootstrap
    // (pair's external_auth PDA + tokenA ATA + tokenB ATA = ~3 accounts).
    console.log("\n[setup] Top up directContract's PDA via HelperProgram.transfer_lamports(directContract, 15M)...");
    try {
        await (await wallet.sendTransaction({ to: HELPER_PROGRAM,
            data: helperIface.encodeFunctionData("transfer_lamports", [directAddr, 15_000_000n]),
            gasLimit: 15_000_000n })).wait();
        console.log(`  ok`);
    } catch (e: any) { console.log(`  err: ${e.message?.slice(0,200)}`); }
    const v1Wusdc = new Contract(V1_WUSDC, erc20Iface, wallet);
    const v2Wbench = new Contract(V2_WBENCH, erc20Iface, wallet);
    const pairA = new Contract(PAIR_A, [...pairIface.fragments, ...erc20Iface.fragments], wallet);

    // ─── Approve RomeswapDirect on both tokens + the pair LP ──────────────
    console.log("\n[setup] Approve RomeswapDirect on wUSDC + wBench + pair LP...");
    const LARGE = 1_000_000_000n;
    try {
        await (await v1Wusdc.approve(directAddr, LARGE, { gasLimit: 15_000_000n })).wait();
        await (await v2Wbench.approve(directAddr, LARGE, { gasLimit: 15_000_000n })).wait();
        await (await pairA.approve(directAddr, LARGE, { gasLimit: 15_000_000n })).wait();
        console.log(`  approves done`);
    } catch (e: any) { console.log(`  approve err: ${e.message?.slice(0,200)}`); }

    // ─── Seed-init Pair A via 3-tx breakdown (cold-bootstrap fits CU when split) ─
    // The cold case needs pair PDA + both ATAs created. Doing this in 1 tx
    // busts CU. Split across 3 txs (deployer-pays-rent path) to safely warm
    // the pair, then bench the single-tx addLiq against the warm state.
    const reserves0 = await pairA.getReserves();
    if (reserves0[0] === 0n && reserves0[1] === 0n) {
        console.log("\n[setup] Seed-init Pair A via 3-tx breakdown (100K wUSDC + 100K wBench)...");
        try {
            const t1 = await v1Wusdc.transfer(PAIR_A, 100_000n, { gasLimit: 30_000_000n });
            await t1.wait();
            console.log(`  tx1 wUSDC.transfer: ${t1.hash}`);
            const t2 = await v2Wbench.transfer(PAIR_A, 100_000n, { gasLimit: 30_000_000n });
            await t2.wait();
            console.log(`  tx2 wBench.transfer: ${t2.hash}`);
            const t3 = await pairA.mint(wallet.address, { gasLimit: 30_000_000n });
            await t3.wait();
            console.log(`  tx3 pair.mint: ${t3.hash}`);
            const r = await pairA.getReserves();
            console.log(`  reserves after seed: ${r[0]} / ${r[1]}`);
        } catch (e: any) {
            console.log(`  SEED FAILED: ${e.message?.slice(0,300)}`);
        }
    } else {
        console.log(`\n[setup] Pair A already has reserves: ${reserves0[0]} / ${reserves0[1]}`);
    }

    // ─── BENCH: addLiq (1-tx) ────────────────────────────────────────────
    const results: Op[] = [];
    results.push(await run("[direct] addLiq (1-tx, wUSDC x wBench, post-init)", async () => {
        const tx = await directContract.addLiq(V1_WUSDC, V2_WBENCH, PAIR_A, 1000n, 1000n, wallet.address, { gasLimit: 60_000_000n });
        await tx.wait();
        return tx.hash;
    }));

    // ─── BENCH: swap (1-tx, wUSDC → wBench) ──────────────────────────────
    results.push(await run("[direct] swap (1-tx, wUSDC -> wBench)", async () => {
        const amtIn = 100n;
        const res = await pairA.getReserves();
        const t0 = await pairA.token0() as string;
        const isUsdc0 = t0.toLowerCase() === V1_WUSDC.toLowerCase();
        const r0 = res[0], r1 = res[1];
        const amtInFee = amtIn * 997n;
        let amount0Out = 0n, amount1Out = 0n;
        if (isUsdc0) {
            amount1Out = (amtInFee * r1) / (r0 * 1000n + amtInFee);
        } else {
            amount0Out = (amtInFee * r0) / (r1 * 1000n + amtInFee);
        }
        const tx = await directContract.swap(V1_WUSDC, PAIR_A, amtIn, amount0Out, amount1Out, wallet.address, { gasLimit: 60_000_000n });
        await tx.wait();
        return tx.hash;
    }));

    // ─── BENCH: removeLiq (1-tx) ─────────────────────────────────────────
    results.push(await run("[direct] removeLiq (1-tx, wUSDC x wBench)", async () => {
        const lp = await pairA.balanceOf(wallet.address) as bigint;
        if (lp === 0n) throw new Error("no LP in deployer; seed-init or earlier addLiq must run first");
        const lpToBurn = lp / 100n > 0n ? lp / 100n : 1n; // 1% of LP
        const tx = await directContract.removeLiq(PAIR_A, lpToBurn, wallet.address, { gasLimit: 60_000_000n });
        await tx.wait();
        return tx.hash;
    }));

    // ─── Output ──────────────────────────────────────────────────────────
    const out = {
        network: "hadrian", chainId: 200010, runAt: new Date().toISOString(),
        methodology: "RomeswapDirect single-tx wrappers. Pre-computed amounts. transferFrom x2 + pair.X inline.",
        deployer: wallet.address, directContract: directAddr, pairA: PAIR_A,
        tokens: { wUSDC: V1_WUSDC, wBench: V2_WBENCH },
        results,
    };
    fs.writeFileSync("deployments/hadrian.romeswap-direct.results.json", JSON.stringify(out, null, 2) + "\n");

    console.log("\n" + "=".repeat(96));
    console.log("ROMESWAP-DIRECT SINGLE-TX RESULTS (Hadrian)");
    console.log("=".repeat(96));
    for (const r of results) {
        const m = typeof r.mean === "number" ? r.mean.toLocaleString().padStart(12) + " CU" : "n/a".padStart(14);
        const verdict = typeof r.mean === "number"
            ? (r.mean < 1_400_000 ? " ✓ FITS 1.4M" : " ✗ EXCEEDS 1.4M")
            : "";
        console.log(`${r.label.padEnd(56)} ${m}${verdict}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
