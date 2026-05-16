/**
 * Phase 3 — DEX bench. Romeswap (Uniswap V2 fork) on Hadrian.
 *
 * Pair types:
 *   A. wrapped x wrapped   : wUSDC (v1) x wBench (v2)
 *   B. wrapped x plain ERC20: wUSDC x MockERC20 (deployed via ERC20Factory)
 *
 * Ops per pair:
 *   - createPair (1 sample; pair creation is idempotent)
 *   - addLiquidity (3 samples, 3-tx Rome breakdown):
 *       tokenA.transfer(pair, amtA) -> tokenB.transfer(pair, amtB) -> pair.mint(to)
 *   - swap (3 samples, 2-tx):
 *       tokenIn.transfer(pair, amtIn) -> pair.swap(amount0Out, amount1Out, to, "")
 *   - removeLiquidity (3 samples, 2-tx):
 *       pair.transfer(pair, lpAmt) -> pair.burn(to)
 *
 * Methodology: real production-contract tx -> rome_solanaTxForEvmTx -> Solana
 * meta.computeUnitsConsumed. For multi-tx flows, sum CU across sub-txs.
 *
 * Output: deployments/hadrian.dex-bench.results.json
 *
 * Usage:
 *   export HARDHAT_VAR_HADRIAN_PRIVATE_KEY=...
 *   npx hardhat run scripts/bench/measure-dex-flows.ts --network hadrian
 */
import fs from "node:fs";
import {
    Wallet,
    JsonRpcProvider,
    Contract,
    Interface,
    getAddress,
} from "ethers";

const HELPER_PROGRAM = "0xff00000000000000000000000000000000000009";
const WITHDRAW_ADDR = "0x4200000000000000000000000000000000000016";
const SOLANA_RPC = "https://api.devnet.solana.com/";
const HADRIAN_RPC = "https://hadrian.testnet.romeprotocol.xyz/";
const SAMPLES = 3;

// Existing Hadrian deploys
const UNI_FACTORY = "0x7A27A84f6D79E8f5e2ddb146b78bdBfBf37539E5";
const ERC20_FACTORY = "0x283A1d9C1Fa19593070aBe676f03Ca384D31242f";
const V1_WUSDC = "0x94AC3E5e998d72088045853C1CfB910F6CE90E56";
// v2 wrapper from real-flow-bench artifact
const V2_BENCH_ARTIFACT_PATH = "deployments/hadrian.real-flow-bench.json";

// ABIs (minimal — only what we call)
const factoryIface = new Interface([
    "function createPair(address tokenA, address tokenB) external returns (address pair)",
    "function getPair(address tokenA, address tokenB) external view returns (address)",
]);
const pairIface = new Interface([
    "function mint(address to) external returns (uint liquidity)",
    "function burn(address to) external returns (uint amount0, uint amount1)",
    "function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function balanceOf(address) external view returns (uint256)",
    "function transfer(address to, uint256 amount) external returns (bool)",
    "function totalSupply() external view returns (uint256)",
]);
const erc20Iface = new Interface([
    "function transfer(address to, uint256 amount) external returns (bool)",
    "function balanceOf(address) external view returns (uint256)",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function decimals() external view returns (uint8)",
    "function mint_to(address to, uint64 amount, bytes calldata) external returns (bool)",
]);
const erc20FactoryIface = new Interface([
    "function createToken(string memory name, string memory symbol, uint8 decimals, uint64 supply) external returns (address)",
    "function tokens(string) external view returns (address)",
]);
const helperIface = new Interface([
    "function swap_gas_to_lamports(uint64 lamports) external",
    "function mint_spl(address to, uint64 amount, bytes32 mint) external",
    "function create_ata(address user, bytes32 mint) external",
]);
const withdrawIface = new Interface([
    "function withdraw_to_ata(uint256 wei_) external",
]);

// ─── RPC helpers ──────────────────────────────────────────────────────
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
async function txCu(h: string): Promise<number> {
    let sigs: string[] = [];
    for (let i = 0; i < 30; i++) { sigs = await romeSig(h); if (sigs.length) break; await new Promise(r => setTimeout(r, 2000)); }
    if (!sigs.length) return 0;
    let total = 0;
    for (const s of sigs) {
        let cu = 0;
        for (let i = 0; i < 10; i++) { cu = await solCu(s); if (cu > 0) break; await new Promise(r => setTimeout(r, 1500)); }
        total += cu;
    }
    return total;
}

interface Op { label: string; samples: any[]; mean: number | "n/a" }
async function run(label: string, fn: (i: number) => Promise<{ hashes: string[]; cu?: number }>): Promise<Op> {
    console.log(`\nProbing: ${label}`);
    const sm: any[] = [];
    for (let i = 0; i < SAMPLES; i++) {
        try {
            const { hashes, cu: precomputed } = await fn(i);
            let cu = precomputed ?? 0;
            if (!cu && hashes.length) {
                for (const h of hashes) cu += await txCu(h);
            }
            console.log(`  ${i+1}/${SAMPLES}: ${hashes.length} txs, cu=${cu.toLocaleString()}`);
            sm.push({ hashes, totalCu: cu });
        } catch (e: any) {
            const m = (e.message || String(e)).slice(0, 200);
            console.log(`  ${i+1}/${SAMPLES}: ERROR ${m}`);
            sm.push({ hashes: [], totalCu: 0, error: m });
        }
    }
    const valid = sm.filter(s => s.totalCu > 0);
    const mean = valid.length ? Math.round(valid.reduce((a, b) => a + b.totalCu, 0) / valid.length) : ("n/a" as const);
    return { label, samples: sm, mean };
}

async function main() {
    const provider = new JsonRpcProvider(HADRIAN_RPC);
    const pk = process.env.HARDHAT_VAR_HADRIAN_PRIVATE_KEY;
    if (!pk) throw new Error("Missing HARDHAT_VAR_HADRIAN_PRIVATE_KEY");
    const wallet = new Wallet(pk, provider);

    const v2Art = JSON.parse(fs.readFileSync(V2_BENCH_ARTIFACT_PATH, "utf8"));
    const V2_WBENCH = v2Art.v2.SPL_ERC20_wBench;
    console.log(`Deployer: ${wallet.address}`);
    console.log(`v1.wUSDC: ${V1_WUSDC}`);
    console.log(`v2.wBench: ${V2_WBENCH}`);

    // ────────────────────────────────────────────────────────────────────
    // SETUP
    // ────────────────────────────────────────────────────────────────────
    console.log("\n=== Setup ===");

    // Top up PDA lamports — each pair needs auto-ATA-create for both tokens
    // (caller-pays rent, ~2M lamports per ATA). 3 ATAs (Pair A wUSDC + wBench;
    // Pair B wUSDC only) + buffer.
    console.log("Top up PDA lamports (20M)...");
    try {
        await (await wallet.sendTransaction({ to: HELPER_PROGRAM,
            data: helperIface.encodeFunctionData("swap_gas_to_lamports", [20_000_000n]),
            gasLimit: 15_000_000n })).wait();
    } catch (e: any) { console.log(`  skip: ${e.message?.slice(0,80)}`); }

    // Ensure wUSDC balance (wrap 0.5 USDC from gas)
    console.log("Wrap 0.5 USDC into v1.wUSDC ATA...");
    try {
        await (await wallet.sendTransaction({ to: WITHDRAW_ADDR,
            data: withdrawIface.encodeFunctionData("withdraw_to_ata", [500_000_000_000_000_000n]),
            gasLimit: 25_000_000n })).wait();
    } catch (e: any) { console.log(`  skip: ${e.message?.slice(0,80)}`); }

    // Deploy MockERC20 via existing ERC20Factory
    console.log("Deploy MockERC20 via ERC20Factory.createToken(name, sym, dec=6, supply=1_000_000)...");
    const erc20Factory = new Contract(ERC20_FACTORY, erc20FactoryIface, wallet);
    let mockToken: string;
    try {
        // Check if already created
        const existing = await erc20Factory.tokens("MOCK");
        if (existing !== "0x0000000000000000000000000000000000000000") {
            mockToken = existing as string;
            console.log(`  reusing existing MOCK: ${mockToken}`);
        } else {
            const tx = await erc20Factory.createToken("Mock Token", "MOCK", 6, 1_000_000_000_000n /* 1M units at 6 decimals */, { gasLimit: 80_000_000n });
            const r = await tx.wait();
            mockToken = await erc20Factory.tokens("MOCK") as string;
            console.log(`  MOCK deployed: ${mockToken} (tx ${tx.hash})`);
        }
    } catch (e: any) {
        throw new Error(`createToken failed: ${e.message?.slice(0,200)}`);
    }
    console.log(`MockERC20 (MOCK): ${mockToken}`);

    // Verify deployer's MOCK balance
    const mockContract = new Contract(mockToken, erc20Iface, wallet);
    const mockBal = await mockContract.balanceOf(wallet.address);
    console.log(`  MOCK balance: ${mockBal.toString()}`);
    if (mockBal === 0n) throw new Error("Deployer has no MOCK balance — supply allocation failed");

    const factory = new Contract(UNI_FACTORY, factoryIface, wallet);
    const v1Wusdc = new Contract(V1_WUSDC, erc20Iface, wallet);
    const v2Wbench = new Contract(V2_WBENCH, erc20Iface, wallet);

    // Verify wUSDC + wBench balances
    const usdcBal = await v1Wusdc.balanceOf(wallet.address);
    const benchBal = await v2Wbench.balanceOf(wallet.address);
    console.log(`  v1.wUSDC balance:  ${usdcBal.toString()}`);
    console.log(`  v2.wBench balance: ${benchBal.toString()}`);

    // Determine which is token0/token1 for each pair (lexicographic order in Uniswap V2)
    const wusdcLower = V1_WUSDC.toLowerCase();
    const wbenchLower = V2_WBENCH.toLowerCase();
    const mockLower = mockToken.toLowerCase();
    const pairA_token0 = wusdcLower < wbenchLower ? V1_WUSDC : V2_WBENCH;
    const pairA_token1 = wusdcLower < wbenchLower ? V2_WBENCH : V1_WUSDC;
    const pairB_token0 = wusdcLower < mockLower ? V1_WUSDC : mockToken;
    const pairB_token1 = wusdcLower < mockLower ? mockToken : V1_WUSDC;

    // ────────────────────────────────────────────────────────────────────
    // BENCH PAIR A: wUSDC x wBench
    // ────────────────────────────────────────────────────────────────────
    const results: Op[] = [];

    let pairA: string = await factory.getPair(V1_WUSDC, V2_WBENCH);
    if (pairA === "0x0000000000000000000000000000000000000000") {
        console.log(`\n=== Pair A (wUSDC x wBench): creating ===`);
        const r = await run("[A] createPair(wUSDC x wBench)", async () => {
            const tx = await factory.createPair(V1_WUSDC, V2_WBENCH, { gasLimit: 120_000_000n });
            await tx.wait();
            return { hashes: [tx.hash] };
        });
        // Only 1 sample for createPair; ignore the loop's other samples (will reuse existing pair)
        results.push(r);
        pairA = await factory.getPair(V1_WUSDC, V2_WBENCH);
    }
    console.log(`Pair A address: ${pairA}`);

    let pairB: string = await factory.getPair(V1_WUSDC, mockToken);
    if (pairB === "0x0000000000000000000000000000000000000000") {
        console.log(`\n=== Pair B (wUSDC x MOCK): creating ===`);
        const r = await run("[B] createPair(wUSDC x MOCK)", async () => {
            const tx = await factory.createPair(V1_WUSDC, mockToken, { gasLimit: 120_000_000n });
            await tx.wait();
            return { hashes: [tx.hash] };
        });
        results.push(r);
        pairB = await factory.getPair(V1_WUSDC, mockToken);
    }
    console.log(`Pair B address: ${pairB}`);

    // Pair contracts as interfaces
    const pAContract = new Contract(pairA, [...pairIface.fragments, ...erc20Iface.fragments], wallet);
    const pBContract = new Contract(pairB, [...pairIface.fragments, ...erc20Iface.fragments], wallet);

    // ────────────────────────────────────────────────────────────────────
    // PAIR A FLOWS (wrapped x wrapped)
    // ────────────────────────────────────────────────────────────────────
    console.log(`\n=== Pair A: addLiquidity (3-tx Rome breakdown) ===`);
    results.push(await run("[A] addLiquidity flow (wUSDC x wBench)", async () => {
        // Each sample uses different small amount to avoid identical-amount nonce collisions.
        const amtA = 1000n;  // wUSDC raw u64
        const amtB = 1000n;  // wBench raw u64
        const t1 = await v1Wusdc.transfer(pairA, amtA, { gasLimit: 20_000_000n });
        await t1.wait();
        const t2 = await v2Wbench.transfer(pairA, amtB, { gasLimit: 20_000_000n });
        await t2.wait();
        const t3 = await pAContract.mint(wallet.address, { gasLimit: 25_000_000n });
        await t3.wait();
        return { hashes: [t1.hash, t2.hash, t3.hash] };
    }));

    console.log(`\n=== Pair A: swap (2-tx) ===`);
    results.push(await run("[A] swap flow (wUSDC -> wBench)", async () => {
        const amtIn = 100n;
        // Determine which side is wUSDC (token0 vs token1)
        const isWusdcToken0 = pairA_token0.toLowerCase() === wusdcLower;
        const t1 = await v1Wusdc.transfer(pairA, amtIn, { gasLimit: 20_000_000n });
        await t1.wait();
        // Compute expected out via getReserves (constant product, ignore fee for sizing)
        const reserves = await pAContract.getReserves();
        const r0 = reserves[0], r1 = reserves[1];
        let amount0Out = 0n, amount1Out = 0n;
        if (isWusdcToken0) {
            // wUSDC in, wBench out — compute via x*y=k with 0.3% fee
            const amtInFee = amtIn * 997n;
            amount1Out = (amtInFee * r1) / (r0 * 1000n + amtInFee);
        } else {
            const amtInFee = amtIn * 997n;
            amount0Out = (amtInFee * r0) / (r1 * 1000n + amtInFee);
        }
        const t2 = await pAContract.swap(amount0Out, amount1Out, wallet.address, "0x", { gasLimit: 25_000_000n });
        await t2.wait();
        return { hashes: [t1.hash, t2.hash] };
    }));

    console.log(`\n=== Pair A: removeLiquidity (2-tx) ===`);
    results.push(await run("[A] removeLiquidity flow (wUSDC x wBench)", async () => {
        // Burn a small portion of LP
        const lpBalance = await pAContract.balanceOf(wallet.address);
        if (lpBalance === 0n) throw new Error("no LP balance — addLiq must run first");
        const lpToBurn = lpBalance / 10n > 0n ? lpBalance / 10n : 1n;  // 10% or 1 wei minimum
        const t1 = await pAContract.transfer(pairA, lpToBurn, { gasLimit: 20_000_000n });
        await t1.wait();
        const t2 = await pAContract.burn(wallet.address, { gasLimit: 25_000_000n });
        await t2.wait();
        return { hashes: [t1.hash, t2.hash] };
    }));

    // ────────────────────────────────────────────────────────────────────
    // PAIR B FLOWS (wrapped x plain ERC20)
    // ────────────────────────────────────────────────────────────────────
    console.log(`\n=== Pair B: addLiquidity (3-tx) ===`);
    results.push(await run("[B] addLiquidity flow (wUSDC x MOCK)", async () => {
        const amtA = 1000n;
        const amtB = 1000n;
        const t1 = await v1Wusdc.transfer(pairB, amtA, { gasLimit: 20_000_000n });
        await t1.wait();
        const t2 = await mockContract.transfer(pairB, amtB, { gasLimit: 20_000_000n });
        await t2.wait();
        const t3 = await pBContract.mint(wallet.address, { gasLimit: 25_000_000n });
        await t3.wait();
        return { hashes: [t1.hash, t2.hash, t3.hash] };
    }));

    console.log(`\n=== Pair B: swap (2-tx) ===`);
    results.push(await run("[B] swap flow (wUSDC -> MOCK)", async () => {
        const amtIn = 100n;
        const isWusdcToken0 = pairB_token0.toLowerCase() === wusdcLower;
        const t1 = await v1Wusdc.transfer(pairB, amtIn, { gasLimit: 20_000_000n });
        await t1.wait();
        const reserves = await pBContract.getReserves();
        const r0 = reserves[0], r1 = reserves[1];
        let amount0Out = 0n, amount1Out = 0n;
        if (isWusdcToken0) {
            const amtInFee = amtIn * 997n;
            amount1Out = (amtInFee * r1) / (r0 * 1000n + amtInFee);
        } else {
            const amtInFee = amtIn * 997n;
            amount0Out = (amtInFee * r0) / (r1 * 1000n + amtInFee);
        }
        const t2 = await pBContract.swap(amount0Out, amount1Out, wallet.address, "0x", { gasLimit: 25_000_000n });
        await t2.wait();
        return { hashes: [t1.hash, t2.hash] };
    }));

    console.log(`\n=== Pair B: removeLiquidity (2-tx) ===`);
    results.push(await run("[B] removeLiquidity flow (wUSDC x MOCK)", async () => {
        const lpBalance = await pBContract.balanceOf(wallet.address);
        if (lpBalance === 0n) throw new Error("no LP balance");
        const lpToBurn = lpBalance / 10n > 0n ? lpBalance / 10n : 1n;
        const t1 = await pBContract.transfer(pairB, lpToBurn, { gasLimit: 20_000_000n });
        await t1.wait();
        const t2 = await pBContract.burn(wallet.address, { gasLimit: 25_000_000n });
        await t2.wait();
        return { hashes: [t1.hash, t2.hash] };
    }));

    // ────────────────────────────────────────────────────────────────────
    // OUTPUT
    // ────────────────────────────────────────────────────────────────────
    const out = {
        network: "hadrian", chainId: 200010, runAt: new Date().toISOString(),
        methodology: "real production-contract tx -> rome_solanaTxForEvmTx -> Solana CU. multi-tx flows summed.",
        deployer: wallet.address,
        pairs: { A: { tokens: [V1_WUSDC, V2_WBENCH], pair: pairA }, B: { tokens: [V1_WUSDC, mockToken], pair: pairB } },
        mockToken,
        results,
    };
    fs.writeFileSync("deployments/hadrian.dex-bench.results.json", JSON.stringify(out, null, 2) + "\n");

    console.log("\n" + "=".repeat(96));
    console.log("DEX FLOW CU RESULTS (Hadrian, mean of 3 samples for flow ops; 1 sample for createPair)");
    console.log("=".repeat(96));
    for (const r of results) {
        const m = typeof r.mean === "number" ? r.mean.toLocaleString().padStart(12) + " CU" : "n/a".padStart(14);
        console.log(`${r.label.padEnd(58)} ${m}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
