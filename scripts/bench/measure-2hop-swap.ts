/**
 * Hypothesis: 2-hop atomic swap fits 1.4M CU.
 *
 * Route: wBench → wUSDC → MOCK via Pair A (wUSDC×wBench) + Pair B (wUSDC×MOCK).
 *
 * Pair A is initialized (102K/102K from prior runs).
 * Pair B needs seed-init via 3-tx breakdown.
 * Then redeploy RomeswapDirect (now with swap2Hop) and bench.
 */
import fs from "node:fs";
import { Wallet, JsonRpcProvider, Contract, Interface, ContractFactory, getAddress } from "ethers";
import directArtifact from "../../artifacts/contracts/cpi/test/RomeswapDirect.sol/RomeswapDirect.json" with { type: "json" };

const HELPER_PROGRAM = "0xff00000000000000000000000000000000000009";
const SOLANA_RPC = "https://api.devnet.solana.com/";
const HADRIAN_RPC = "https://hadrian.testnet.romeprotocol.xyz/";

const V1_WUSDC = "0x94AC3E5e998d72088045853C1CfB910F6CE90E56";
const PAIR_A = "0x45350dF36fA7334C2E267598Af8fC136e4982A9E";  // wUSDC × wBench
const PAIR_B = "0x9FB2471A400CA670F5459829b622A2f4d4824642";  // wUSDC × MOCK
const MOCK = "0x5cB734B113E31005487D7E4bcA39BCC3e17B8e9A";
const SAMPLES = 3;

const helperIface = new Interface([
    "function swap_gas_to_lamports(uint64 lamports) external",
    "function transfer_lamports(address to, uint64 lamports) external",
]);
const erc20Iface = new Interface([
    "function transfer(address to, uint256 amount) external returns (bool)",
    "function transferFrom(address from, address to, uint256 amount) external returns (bool)",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function balanceOf(address) external view returns (uint256)",
]);
const pairIface = new Interface([
    "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() external view returns (address)",
    "function mint(address to) external returns (uint256 liquidity)",
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

async function main() {
    const provider = new JsonRpcProvider(HADRIAN_RPC);
    const pk = process.env.HARDHAT_VAR_HADRIAN_PRIVATE_KEY;
    if (!pk) throw new Error("Missing HARDHAT_VAR_HADRIAN_PRIVATE_KEY");
    const wallet = new Wallet(pk, provider);

    const v2Art = JSON.parse(fs.readFileSync("deployments/hadrian.real-flow-bench.json", "utf8"));
    const V2_WBENCH = v2Art.v2.SPL_ERC20_wBench;
    console.log(`Deployer: ${wallet.address}`);
    console.log(`wUSDC: ${V1_WUSDC}`);
    console.log(`wBench: ${V2_WBENCH}`);
    console.log(`MOCK:  ${MOCK}`);
    console.log(`Pair A (wUSDC × wBench): ${PAIR_A}`);
    console.log(`Pair B (wUSDC × MOCK):   ${PAIR_B}`);

    // Top up PDA.
    console.log("\n[setup] swap_gas_to_lamports(10M)...");
    try {
        await (await wallet.sendTransaction({ to: HELPER_PROGRAM,
            data: helperIface.encodeFunctionData("swap_gas_to_lamports", [10_000_000n]),
            gasLimit: 15_000_000n })).wait();
    } catch (e: any) { console.log(`  skip: ${e.message?.slice(0,80)}`); }

    // Deploy fresh RomeswapDirect (now with swap2Hop).
    console.log("\n[deploy] RomeswapDirect (now with swap2Hop)...");
    const factory = new ContractFactory(directArtifact.abi, directArtifact.bytecode, wallet);
    const direct = await factory.deploy();
    await direct.waitForDeployment();
    const directAddr = await direct.getAddress();
    console.log(`        ${directAddr}`);

    const directContract = new Contract(directAddr, directArtifact.abi, wallet);
    const v1Wusdc = new Contract(V1_WUSDC, erc20Iface, wallet);
    const v2Wbench = new Contract(V2_WBENCH, erc20Iface, wallet);
    const mock = new Contract(MOCK, erc20Iface, wallet);
    const pairA = new Contract(PAIR_A, [...pairIface.fragments, ...erc20Iface.fragments], wallet);
    const pairB = new Contract(PAIR_B, [...pairIface.fragments, ...erc20Iface.fragments], wallet);

    // Top up directContract's PDA.
    console.log("\n[setup] transfer_lamports(directContract, 15M)...");
    try {
        await (await wallet.sendTransaction({ to: HELPER_PROGRAM,
            data: helperIface.encodeFunctionData("transfer_lamports", [directAddr, 15_000_000n]),
            gasLimit: 15_000_000n })).wait();
        console.log(`  ok`);
    } catch (e: any) { console.log(`  err: ${e.message?.slice(0,200)}`); }

    // Approvals.
    console.log("\n[setup] Approve RomeswapDirect on wBench (input token for 2-hop)...");
    try {
        await (await v2Wbench.approve(directAddr, 1_000_000_000n, { gasLimit: 15_000_000n })).wait();
        console.log(`  ok`);
    } catch (e: any) { console.log(`  err: ${e.message?.slice(0,200)}`); }

    // Seed Pair B if not initialized.
    const reservesB0 = await pairB.getReserves();
    if (reservesB0[0] === 0n && reservesB0[1] === 0n) {
        console.log("\n[setup] Seed Pair B (100K wUSDC + 100K MOCK) via 3-tx breakdown...");
        try {
            const t1 = await v1Wusdc.transfer(PAIR_B, 100_000n, { gasLimit: 30_000_000n });
            await t1.wait();
            console.log(`  tx1 wUSDC.transfer: ${t1.hash}`);
            const t2 = await mock.transfer(PAIR_B, 100_000n, { gasLimit: 30_000_000n });
            await t2.wait();
            console.log(`  tx2 MOCK.transfer: ${t2.hash}`);
            const t3 = await pairB.mint(wallet.address, { gasLimit: 30_000_000n });
            await t3.wait();
            console.log(`  tx3 pair.mint: ${t3.hash}`);
            const r = await pairB.getReserves();
            console.log(`  Pair B reserves: ${r[0]} / ${r[1]}`);
        } catch (e: any) {
            console.log(`  SEED FAILED: ${e.message?.slice(0,300)}`);
        }
    } else {
        console.log(`\n[setup] Pair B already seeded: ${reservesB0[0]} / ${reservesB0[1]}`);
    }

    const reservesA = await pairA.getReserves();
    const reservesB = await pairB.getReserves();
    const tokenA0 = (await pairA.token0() as string).toLowerCase();
    const tokenB0 = (await pairB.token0() as string).toLowerCase();
    console.log(`\nPair A reserves (token0=${tokenA0===V1_WUSDC.toLowerCase()?'wUSDC':'wBench'}): ${reservesA[0]} / ${reservesA[1]}`);
    console.log(`Pair B reserves (token0=${tokenB0===V1_WUSDC.toLowerCase()?'wUSDC':'MOCK'}):  ${reservesB[0]} / ${reservesB[1]}`);

    // Pre-compute 2-hop amounts: wBench → wUSDC → MOCK
    const amtIn = 100n;
    // Hop 1: wBench in, wUSDC out, on Pair A
    // wBench is which token of Pair A?
    const wBenchIsToken0A = tokenA0 === V2_WBENCH.toLowerCase();
    const rIn_A  = wBenchIsToken0A ? reservesA[0] : reservesA[1];   // wBench reserve
    const rOut_A = wBenchIsToken0A ? reservesA[1] : reservesA[0];   // wUSDC reserve
    const fee = 997n;
    const inFee_A = amtIn * fee;
    const amtUsdcOut = (inFee_A * rOut_A) / (rIn_A * 1000n + inFee_A);
    const amount0OutA = wBenchIsToken0A ? 0n : amtUsdcOut;
    const amount1OutA = wBenchIsToken0A ? amtUsdcOut : 0n;

    // Hop 2: wUSDC in (just received from Pair A), MOCK out, on Pair B
    const wUsdcIsToken0B = tokenB0 === V1_WUSDC.toLowerCase();
    const rIn_B  = wUsdcIsToken0B ? reservesB[0] : reservesB[1];   // wUSDC reserve
    const rOut_B = wUsdcIsToken0B ? reservesB[1] : reservesB[0];   // MOCK reserve
    const inFee_B = amtUsdcOut * fee;
    const amtMockOut = (inFee_B * rOut_B) / (rIn_B * 1000n + inFee_B);
    const amount0OutB = wUsdcIsToken0B ? 0n : amtMockOut;
    const amount1OutB = wUsdcIsToken0B ? amtMockOut : 0n;

    console.log(`\nQuote: ${amtIn} wBench → ${amtUsdcOut} wUSDC → ${amtMockOut} MOCK`);
    console.log(`Pair A: amount0Out=${amount0OutA}, amount1Out=${amount1OutA}`);
    console.log(`Pair B: amount0Out=${amount0OutB}, amount1Out=${amount1OutB}`);

    // Run 3 samples of 2-hop swap.
    console.log(`\n=== BENCH: 2-hop swap wBench → wUSDC → MOCK ===`);
    const samples: any[] = [];
    for (let i = 0; i < SAMPLES; i++) {
        try {
            // Recompute quote each sample (reserves shift).
            const rA = await pairA.getReserves();
            const rB = await pairB.getReserves();
            const t0A = tokenA0 === V2_WBENCH.toLowerCase();
            const rin_a = t0A ? rA[0] : rA[1];
            const rout_a = t0A ? rA[1] : rA[0];
            const u_out = (amtIn * fee * rout_a) / (rin_a * 1000n + amtIn * fee);
            const t0B = tokenB0 === V1_WUSDC.toLowerCase();
            const rin_b = t0B ? rB[0] : rB[1];
            const rout_b = t0B ? rB[1] : rB[0];
            const m_out = (u_out * fee * rout_b) / (rin_b * 1000n + u_out * fee);
            const aA0 = t0A ? 0n : u_out, aA1 = t0A ? u_out : 0n;
            const aB0 = t0B ? 0n : m_out, aB1 = t0B ? m_out : 0n;

            const tx = await directContract.swap2Hop(
                V2_WBENCH, PAIR_A, PAIR_B, amtIn, aA0, aA1, aB0, aB1, wallet.address,
                { gasLimit: 80_000_000n }
            );
            await tx.wait();
            const { sigs, perTx, totalCu: cu } = await totalCu(tx.hash);
            console.log(`  ${i+1}/${SAMPLES}: ${tx.hash.slice(0,12)}... sigs=${sigs.length} cu=${cu.toLocaleString()} ${cu < 1_400_000 ? "✓ fits 1.4M" : "✗ busts 1.4M"}`);
            samples.push({ evmHash: tx.hash, sigs, perTx, totalCu: cu });
        } catch (e: any) {
            const m = (e.message || String(e)).slice(0, 250);
            console.log(`  ${i+1}/${SAMPLES}: ERROR ${m}`);
            samples.push({ evmHash: "0x", totalCu: 0, error: m });
        }
    }

    const valid = samples.filter(s => s.totalCu > 0);
    const mean = valid.length ? Math.round(valid.reduce((a, b) => a + b.totalCu, 0) / valid.length) : 0;

    const out = {
        network: "hadrian", chainId: 200010, runAt: new Date().toISOString(),
        route: "wBench → wUSDC → MOCK", pair1: PAIR_A, pair2: PAIR_B,
        directContract: directAddr, mean, samples,
    };
    fs.writeFileSync("deployments/hadrian.2hop-bench.results.json", JSON.stringify(out, null, 2) + "\n");

    console.log("\n" + "=".repeat(80));
    console.log(`2-HOP SWAP MEAN: ${mean.toLocaleString()} CU  ${mean && mean < 1_400_000 ? "✓ FITS 1.4M" : mean ? "✗ EXCEEDS 1.4M" : "(no valid samples)"}`);
    console.log(`Margin to ceiling: ${mean ? (1400000 - mean).toLocaleString() + " CU" : "n/a"}`);
    console.log("=".repeat(80));
}

main().catch((e) => { console.error(e); process.exit(1); });
