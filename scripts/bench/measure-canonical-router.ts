/**
 * Canonical UniswapV2Router measurement on Hadrian (post-#364 / post-universal-delegation).
 *
 * Hypotheses to test:
 *   1. swap (single-hop) via canonical router fits 1.4M — vs lean direct router 886K
 *   2. addLiquidity via canonical router NOW fits post-#364 (was busting pre-savings)
 *   3. removeLiquidity via canonical router (2-step: LP-approve + remove) measurement
 *   4. removeLiquidityWithPermit using LP token's canonical permit — 1-tx UX
 *   5. swapExactTokensForTokens with 2-hop path — does canonical busts vs lean?
 *
 * Each test: 3 samples, atomic, on existing PairA/PairB.
 *
 * Output: deployments/hadrian.canonical-router.results.json
 */
import fs from "node:fs";
import {
    Wallet, JsonRpcProvider, Contract, Interface, getAddress,
} from "ethers";

const HELPER_PROGRAM = "0xff00000000000000000000000000000000000009";
const SOLANA_RPC = "https://api.devnet.solana.com/";
const HADRIAN_RPC = "https://hadrian.testnet.romeprotocol.xyz/";

const V1_WUSDC = "0x94AC3E5e998d72088045853C1CfB910F6CE90E56";
const PAIR_A = "0x45350dF36fA7334C2E267598Af8fC136e4982A9E";
const PAIR_B = "0x9FB2471A400CA670F5459829b622A2f4d4824642";
const MOCK = "0x5cB734B113E31005487D7E4bcA39BCC3e17B8e9A";
const ROUTER = "0xB342f70D56855F11B0721FcBE2804A200d0F0533";
const FACTORY = "0x7A27A84f6D79E8f5e2ddb146b78bdBfBf37539E5";
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
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function decimals() external view returns (uint8)",
]);
const pairIface = new Interface([
    "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function balanceOf(address) external view returns (uint256)",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function nonces(address) external view returns (uint256)",
    "function DOMAIN_SEPARATOR() external view returns (bytes32)",
]);
const routerIface = new Interface([
    "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) external returns (uint[] amounts)",
    "function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB, uint liquidity)",
    "function removeLiquidity(address tokenA, address tokenB, uint liquidity, uint amountAMin, uint amountBMin, address to, uint deadline) external returns (uint amountA, uint amountB)",
    "function removeLiquidityWithPermit(address tokenA, address tokenB, uint liquidity, uint amountAMin, uint amountBMin, address to, uint deadline, bool approveMax, uint8 v, bytes32 r, bytes32 s) external returns (uint amountA, uint amountB)",
    "function getAmountsOut(uint amountIn, address[] path) external view returns (uint[] amounts)",
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
    if (!sigs.length) return { sigs: [], perTx: [], totalCu: 0 };
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
    console.log(`\n=== ${label} ===`);
    const sm: any[] = [];
    for (let i = 0; i < SAMPLES; i++) {
        try {
            const h = await fn(i);
            const { sigs, perTx, totalCu: cu } = await totalCu(h);
            const ok = cu > 0 && cu < 1_400_000;
            console.log(`  ${i+1}/${SAMPLES}: ${h.slice(0,12)}... sigs=${sigs.length} cu=${cu.toLocaleString()} ${ok ? "✓" : (cu >= 1_400_000 ? "✗ over 1.4M" : "✗ no CU")}`);
            sm.push({ evmHash: h, sigs, perTx, totalCu: cu });
        } catch (e: any) {
            const m = (e.message || String(e)).slice(0, 220);
            const isPreflight = m.includes("-32000") || m.includes("TooManyCompute") || m.includes("insufficient gas");
            console.log(`  ${i+1}/${SAMPLES}: ✗ ${isPreflight ? "PREFLIGHT REJECT (busts CU)" : "ERROR"} — ${m}`);
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
    console.log(`Router:   ${ROUTER}`);

    const v2Art = JSON.parse(fs.readFileSync("deployments/hadrian.real-flow-bench.json", "utf8"));
    const V2_WBENCH = v2Art.v2.SPL_ERC20_wBench;

    // Setup
    console.log("\n[setup] PDA top-up...");
    try {
        await (await wallet.sendTransaction({ to: HELPER_PROGRAM,
            data: helperIface.encodeFunctionData("swap_gas_to_lamports", [5_000_000n]),
            gasLimit: 15_000_000n })).wait();
    } catch (e: any) { console.log(`  skip: ${e.message?.slice(0,80)}`); }

    const v1Wusdc = new Contract(V1_WUSDC, erc20Iface, wallet);
    const v2Wbench = new Contract(V2_WBENCH, erc20Iface, wallet);
    const mock = new Contract(MOCK, erc20Iface, wallet);
    const pairA = new Contract(PAIR_A, [...pairIface.fragments, ...erc20Iface.fragments], wallet);
    const pairB = new Contract(PAIR_B, [...pairIface.fragments, ...erc20Iface.fragments], wallet);
    const router = new Contract(ROUTER, routerIface, wallet);

    // Approve canonical Router on all 4 tokens (wUSDC, wBench, MOCK, PairA LP)
    console.log("[setup] Approve canonical Router on wUSDC + wBench + MOCK + PairA LP + PairB LP...");
    for (const [name, c] of [["wUSDC", v1Wusdc], ["wBench", v2Wbench], ["MOCK", mock], ["PairA-LP", pairA], ["PairB-LP", pairB]] as const) {
        try {
            const cur = await (c as any).allowance(wallet.address, ROUTER);
            if (cur === 0n) {
                const tx = await (c as any).approve(ROUTER, 1_000_000_000n, { gasLimit: 15_000_000n });
                await tx.wait();
                console.log(`  ${name}.approve(Router): ${tx.hash}`);
            } else {
                console.log(`  ${name}.allowance(Router) already ${cur}`);
            }
        } catch (e: any) { console.log(`  ${name} approve err: ${e.message?.slice(0,100)}`); }
    }

    const rA = await pairA.getReserves();
    const rB = await pairB.getReserves();
    console.log(`\nPair A reserves: ${rA[0]} / ${rA[1]}`);
    console.log(`Pair B reserves: ${rB[0]} / ${rB[1]}`);
    const userLpA = await pairA.balanceOf(wallet.address);
    console.log(`User LP on Pair A: ${userLpA}`);

    const results: Op[] = [];
    const NOW_SEC = Math.floor(Date.now() / 1000);
    const DEADLINE = NOW_SEC + 600;

    // ─── Test 1: canonical router single-hop swap ─────────────────
    results.push(await run("[canonical] router.swapExactTokensForTokens single-hop (wUSDC→wBench)", async () => {
        const amts = await router.getAmountsOut(100n, [V1_WUSDC, V2_WBENCH]);
        const tx = await router.swapExactTokensForTokens(100n, amts[1] * 95n / 100n, [V1_WUSDC, V2_WBENCH], wallet.address, DEADLINE, { gasLimit: 40_000_000n });
        await tx.wait();
        return tx.hash;
    }));

    // ─── Test 2: canonical router 2-hop swap (PROBABLY busts) ─────────────────
    results.push(await run("[canonical] router.swapExactTokensForTokens 2-hop (wBench→wUSDC→MOCK)", async () => {
        const path = [V2_WBENCH, V1_WUSDC, MOCK];
        const amts = await router.getAmountsOut(100n, path);
        const tx = await router.swapExactTokensForTokens(100n, amts[2] * 95n / 100n, path, wallet.address, DEADLINE, { gasLimit: 50_000_000n });
        await tx.wait();
        return tx.hash;
    }));

    // ─── Test 3: canonical router.addLiquidity (post-#364 — does it now fit?) ─────────────────
    results.push(await run("[canonical] router.addLiquidity (wUSDC × wBench)", async () => {
        const tx = await router.addLiquidity(V1_WUSDC, V2_WBENCH, 1000n, 1000n, 1n, 1n, wallet.address, DEADLINE, { gasLimit: 80_000_000n });
        await tx.wait();
        return tx.hash;
    }));

    // ─── Test 4: canonical router.removeLiquidity (2-step: LP-approve + remove) ─────────────
    results.push(await run("[canonical] router.removeLiquidity (assumes LP pre-approved)", async () => {
        const lpBal = await pairA.balanceOf(wallet.address);
        if (lpBal === 0n) throw new Error("no LP balance");
        const burnAmt = lpBal > 100n ? lpBal / 100n : 1n;  // 1% or 1 wei minimum
        const tx = await router.removeLiquidity(V1_WUSDC, V2_WBENCH, burnAmt, 1n, 1n, wallet.address, DEADLINE, { gasLimit: 50_000_000n });
        await tx.wait();
        return tx.hash;
    }));

    // ─── Test 5: canonical removeLiquidityWithPermit — the big one ─────────────
    results.push(await run("[canonical] router.removeLiquidityWithPermit (1-tx with LP permit signature)", async () => {
        const lpBal = await pairA.balanceOf(wallet.address);
        if (lpBal === 0n) throw new Error("no LP balance");
        const burnAmt = lpBal > 100n ? lpBal / 100n : 1n;

        // Sign EIP-712 permit for the LP token (PairA)
        const nonce = await pairA.nonces(wallet.address);
        const chainId = (await provider.getNetwork()).chainId;
        const domain = {
            name: "Romeswap V2",  // rome-uniswap-v2/contracts/UniswapV2ERC20.sol uses this
            version: "1",
            chainId,
            verifyingContract: PAIR_A,
        };
        const types = {
            Permit: [
                { name: "owner",    type: "address" },
                { name: "spender",  type: "address" },
                { name: "value",    type: "uint256" },
                { name: "nonce",    type: "uint256" },
                { name: "deadline", type: "uint256" },
            ],
        };
        const value = {
            owner: wallet.address,
            spender: ROUTER,
            value: burnAmt,
            nonce,
            deadline: DEADLINE,
        };
        const sig = await wallet.signTypedData(domain, types, value);
        const { v, r, s } = (await import("ethers")).Signature.from(sig);

        const tx = await router.removeLiquidityWithPermit(
            V1_WUSDC, V2_WBENCH, burnAmt, 1n, 1n, wallet.address, DEADLINE,
            false, v, r, s,
            { gasLimit: 50_000_000n }
        );
        await tx.wait();
        return tx.hash;
    }));

    // ─── Output ─────────────────────────────────────────
    const out = {
        network: "hadrian", chainId: 200010, runAt: new Date().toISOString(),
        router: ROUTER, deployer: wallet.address,
        results,
    };
    fs.writeFileSync("deployments/hadrian.canonical-router.results.json", JSON.stringify(out, null, 2) + "\n");

    console.log("\n" + "=".repeat(110));
    console.log("CANONICAL UNISWAP V2 ROUTER ON HADRIAN — MEAN CU (3 samples)");
    console.log("=".repeat(110));
    for (const r of results) {
        const m = typeof r.mean === "number" ? r.mean.toLocaleString().padStart(12) + " CU" : "        n/a   ";
        const verdict = typeof r.mean === "number"
            ? (r.mean < 1_400_000 ? " ✓ FITS 1.4M" : " ✗ BUSTS")
            : " ✗ failed all samples";
        console.log(`${r.label.padEnd(78)} ${m}${verdict}`);
    }
    console.log("=".repeat(110));
}

main().catch((e) => { console.error(e); process.exit(1); });
