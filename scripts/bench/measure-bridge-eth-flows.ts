/**
 * Phase 2 follow-up. Focused bench of wETH-dependent ops only.
 * 4 ops x 3 samples = 12 txs total. Merges into existing results JSON.
 *
 * Prereq: deployer has wETH balance on Hadrian.
 *
 * Usage:
 *   export HARDHAT_VAR_HADRIAN_PRIVATE_KEY=...
 *   npx hardhat run scripts/bench/measure-bridge-eth-flows.ts --network hadrian
 */
import fs from "node:fs";
import {
    Wallet,
    JsonRpcProvider,
    Contract,
    Interface,
    getAddress,
} from "ethers";
import withdrawArtifact from "../../artifacts/contracts/bridge/RomeBridgeWithdraw.sol/RomeBridgeWithdraw.json" with { type: "json" };
import wrapperArtifact from "../../artifacts/contracts/erc20spl/erc20spl.sol/SPL_ERC20.json" with { type: "json" };

const HELPER_PROGRAM = "0xff00000000000000000000000000000000000009";
const SOLANA_RPC = "https://api.devnet.solana.com/";
const HADRIAN_RPC = "https://hadrian.testnet.romeprotocol.xyz/";
const ART = "deployments/hadrian.real-flow-bench.json";
const RES = "deployments/hadrian.real-flow-bench.results.json";
const SAMPLES = 3;

const helperIface = new Interface([
    "function swap_gas_to_lamports(uint64 lamports) external",
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
            const m = (e.message || String(e)).slice(0, 200);
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

    const art = JSON.parse(fs.readFileSync(ART, "utf8"));
    const v1 = art.v1, v2 = art.v2;
    console.log(`Deployer: ${wallet.address}`);

    const v1Weth = new Contract(v1.SPL_ERC20_WETH, wrapperArtifact.abi, wallet);
    const bal = await v1Weth.balanceOf(wallet.address);
    console.log(`v1.wETH balance: ${bal.toString()}`);
    if (bal === 0n) {
        console.log("Zero wETH. Bridge ETH from Sepolia first.");
        process.exit(2);
    }

    console.log("Top up PDA lamports (5M)...");
    try {
        const sw = await wallet.sendTransaction({
            to: HELPER_PROGRAM,
            data: helperIface.encodeFunctionData("swap_gas_to_lamports", [5_000_000n]),
            gasLimit: 15_000_000n,
        });
        await sw.wait();
    } catch (e: any) { console.log(`  skip: ${e.message?.slice(0,100)}`); }

    const v1B = new Contract(v1.RomeBridgeWithdraw, withdrawArtifact.abi, wallet);
    const v2B = new Contract(v2.RomeBridgeWithdraw, withdrawArtifact.abi, wallet);
    const ETH_RX = getAddress("0x000000000000000000000000000000000000beef");

    const focused: Op[] = [];
    focused.push(await run("[v1] RomeBridgeWithdraw.approveBurnETH", async (i) => {
        const tx = await v1B.approveBurnETH(100n + BigInt(i), { gasLimit: 20_000_000n });
        await tx.wait(); return tx.hash;
    }));
    focused.push(await run("[v2] RomeBridgeWithdraw.approveBurnETH", async (i) => {
        const tx = await v2B.approveBurnETH(100n + BigInt(i), { gasLimit: 20_000_000n });
        await tx.wait(); return tx.hash;
    }));
    focused.push(await run("[v1] RomeBridgeWithdraw.burnETH", async () => {
        await (await v1B.approveBurnETH(1000n, { gasLimit: 20_000_000n })).wait();
        const tx = await v1B.burnETH(1n, ETH_RX, { gasLimit: 25_000_000n });
        await tx.wait(); return tx.hash;
    }));
    focused.push(await run("[v2] RomeBridgeWithdraw.burnETH", async () => {
        await (await v2B.approveBurnETH(1000n, { gasLimit: 20_000_000n })).wait();
        const tx = await v2B.burnETH(1n, ETH_RX, { gasLimit: 25_000_000n });
        await tx.wait(); return tx.hash;
    }));

    let ex: any = {};
    try { ex = JSON.parse(fs.readFileSync(RES, "utf8")); } catch {}
    const labels = new Set(focused.map(r => r.label));
    ex.results = (ex.results ?? []).filter((r: Op) => !labels.has(r.label)).concat(focused);
    ex.lastFocusedRunAt = new Date().toISOString();
    fs.writeFileSync(RES, JSON.stringify(ex, null, 2) + "\n");

    console.log("\n" + "=".repeat(80));
    for (const r of focused) {
        const m = typeof r.mean === "number" ? r.mean.toLocaleString() + " CU" : "n/a";
        console.log(`${r.label.padEnd(58)} ${m.padStart(12)}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
