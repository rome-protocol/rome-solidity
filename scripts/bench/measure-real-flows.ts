/**
 * Phase 2 — Measure real-flow CU on Hadrian for v1 vs new.
 * 9 ops x 2 versions x 3 samples. Real production-contract txs.
 */
import fs from "node:fs";
import {
    Wallet,
    JsonRpcProvider,
    Contract,
    Interface,
} from "ethers";
import wrapperArtifact from "../../artifacts/contracts/erc20spl/erc20spl.sol/SPL_ERC20.json" with { type: "json" };
import factoryArtifact from "../../artifacts/contracts/erc20spl/erc20spl_factory.sol/ERC20SPLFactory.json" with { type: "json" };
import withdrawArtifact from "../../artifacts/contracts/bridge/RomeBridgeWithdraw.sol/RomeBridgeWithdraw.json" with { type: "json" };

const HELPER_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000009";
const WITHDRAW_ADDRESS = "0x4200000000000000000000000000000000000016";
const SOLANA_RPC = "https://api.devnet.solana.com/";
const HADRIAN_RPC = "https://hadrian.testnet.romeprotocol.xyz/";
const ARTIFACT_PATH = "deployments/hadrian.real-flow-bench.json";
const RESULTS_PATH = "deployments/hadrian.real-flow-bench.results.json";
const SAMPLES = 3;

const helperIface = new Interface([
    "function swap_gas_to_lamports(uint64 lamports) external",
    "function mint_spl(address to, uint64 amount, bytes32 mint) external",
    "function create_ata(address user, bytes32 mint) external",
]);
const withdrawIface = new Interface([
    "function withdraw_to_ata(uint256 wei_) external",
]);

async function romeSolToEvm(evmHash: string): Promise<string[]> {
    const res = await fetch(HADRIAN_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rome_solanaTxForEvmTx", params: [evmHash] }),
    });
    const body = (await res.json()) as { result?: string[]; error?: { message: string } };
    if (body.error) throw new Error(`rome_solanaTxForEvmTx: ${body.error.message}`);
    return body.result ?? [];
}
async function getSolanaCu(sig: string): Promise<number> {
    const res = await fetch(SOLANA_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction",
            params: [sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }),
    });
    const body = (await res.json()) as { result?: { meta?: { computeUnitsConsumed?: number } } };
    return body.result?.meta?.computeUnitsConsumed ?? 0;
}
async function totalCu(evmHash: string): Promise<{ sigs: string[]; perTx: number[]; totalCu: number }> {
    let sigs: string[] = [];
    for (let i = 0; i < 30; i++) {
        sigs = await romeSolToEvm(evmHash);
        if (sigs.length > 0) break;
        await new Promise(r => setTimeout(r, 2000));
    }
    if (sigs.length === 0) throw new Error(`empty Solana sigs for ${evmHash}`);
    const perTx: number[] = [];
    for (const sig of sigs) {
        let cu = 0;
        for (let i = 0; i < 10; i++) {
            cu = await getSolanaCu(sig);
            if (cu > 0) break;
            await new Promise(r => setTimeout(r, 1500));
        }
        perTx.push(cu);
    }
    return { sigs, perTx, totalCu: perTx.reduce((a, b) => a + b, 0) };
}

interface OpResult { label: string; samples: any[]; mean: number | "n/a" }
async function runSamples(label: string, exec: (i: number) => Promise<string>): Promise<OpResult> {
    console.log(`\nProbing: ${label}`);
    const samples: any[] = [];
    for (let i = 0; i < SAMPLES; i++) {
        try {
            const evmHash = await exec(i);
            const { sigs, perTx, totalCu: cu } = await totalCu(evmHash);
            console.log(`  sample ${i+1}/${SAMPLES}: evmTx=${evmHash.slice(0,12)}... sigs=${sigs.length} cu=${cu.toLocaleString()}`);
            samples.push({ evmHash, sigs, perTx, totalCu: cu });
        } catch (err: any) {
            const msg = (err.message || String(err)).slice(0, 200);
            console.log(`  sample ${i+1}/${SAMPLES}: ERROR - ${msg}`);
            samples.push({ evmHash: "0x", sigs: [], perTx: [], totalCu: 0, error: msg });
        }
    }
    const valid = samples.filter(s => s.totalCu > 0);
    const mean = valid.length > 0 ? Math.round(valid.reduce((a, b) => a + b.totalCu, 0) / valid.length) : ("n/a" as const);
    return { label, samples, mean };
}

async function main() {
    const provider = new JsonRpcProvider(HADRIAN_RPC);
    const pk = process.env.HARDHAT_VAR_HADRIAN_PRIVATE_KEY;
    if (!pk) throw new Error("Missing HARDHAT_VAR_HADRIAN_PRIVATE_KEY");
    const wallet = new Wallet(pk, provider);

    const art = JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8"));
    const v1 = art.v1, v2 = art.v2;
    console.log(`Deployer:  ${wallet.address}`);

    // SETUP
    console.log("\n=== Setup ===");
    console.log("Top up PDA lamports (10M)...");
    const sw = await wallet.sendTransaction({
        to: HELPER_PROGRAM_ADDRESS,
        data: helperIface.encodeFunctionData("swap_gas_to_lamports", [10_000_000n]),
        gasLimit: 15_000_000n,
    });
    await sw.wait();

    console.log("Wrap 1 USDC into v1.wUSDC ATA...");
    try {
        const w = await wallet.sendTransaction({
            to: WITHDRAW_ADDRESS,
            data: withdrawIface.encodeFunctionData("withdraw_to_ata", [1_000_000_000_000_000_000n]),
            gasLimit: 20_000_000n,
        });
        await w.wait();
        console.log(`  ok ${w.hash}`);
    } catch (e: any) { console.log(`  skip: ${e.message?.slice(0, 100)}`); }

    console.log("Create deployer's wBench ATA first (mint_spl needs destination ATA)...");
    try {
        const cAta = await wallet.sendTransaction({
            to: HELPER_PROGRAM_ADDRESS,
            data: helperIface.encodeFunctionData("create_ata", [wallet.address, v2.wBenchMint]),
            gasLimit: 20_000_000n,
        });
        await cAta.wait();
        console.log(`  ok ${cAta.hash}`);
    } catch (e: any) { console.log(`  skip: ${e.message?.slice(0, 200)}`); }

    console.log("Mint 1000 wBench to deployer...");
    try {
        const m = await wallet.sendTransaction({
            to: HELPER_PROGRAM_ADDRESS,
            data: helperIface.encodeFunctionData("mint_spl", [wallet.address, 1_000_000_000n, v2.wBenchMint]),
            gasLimit: 20_000_000n,
        });
        await m.wait();
        console.log(`  ok ${m.hash}`);
    } catch (e: any) { console.log(`  skip: ${e.message?.slice(0, 200)}`); }

    const v1Wusdc = new Contract(v1.SPL_ERC20_USDC, wrapperArtifact.abi, wallet);
    const v2Wbench = new Contract(v2.SPL_ERC20_wBench, wrapperArtifact.abi, wallet);
    const v1Bridge = new Contract(v1.RomeBridgeWithdraw, withdrawArtifact.abi, wallet);
    const v2Bridge = new Contract(v2.RomeBridgeWithdraw, withdrawArtifact.abi, wallet);
    const v1Factory = new Contract(v1.ERC20SPLFactory, factoryArtifact.abi, wallet);
    const v2Factory = new Contract(v2.ERC20SPLFactory, factoryArtifact.abi, wallet);

    const { getAddress } = await import("ethers");
    const RECIPIENT = getAddress("0x000000000000000000000000000000000000dead");
    const SPENDER = getAddress("0x000000000000000000000000000000000000face");
    const SOLANA_DEST = "0x" + "ab".repeat(32);
    const ETH_RECIPIENT = getAddress("0x000000000000000000000000000000000000beef");

    const results: OpResult[] = [];

    results.push(await runSamples("[v1] SPL_ERC20.transfer", async () => {
        const tx = await v1Wusdc.transfer(RECIPIENT, 1n, { gasLimit: 20_000_000n });
        await tx.wait(); return tx.hash;
    }));
    results.push(await runSamples("[v2] SPL_ERC20.transfer", async () => {
        const tx = await v2Wbench.transfer(RECIPIENT, 1n, { gasLimit: 20_000_000n });
        await tx.wait(); return tx.hash;
    }));

    results.push(await runSamples("[v1] SPL_ERC20.approve", async (i) => {
        const tx = await v1Wusdc.approve(SPENDER, 100n + BigInt(i), { gasLimit: 15_000_000n });
        await tx.wait(); return tx.hash;
    }));
    results.push(await runSamples("[v2] SPL_ERC20.approve", async (i) => {
        const tx = await v2Wbench.approve(SPENDER, 100n + BigInt(i), { gasLimit: 15_000_000n });
        await tx.wait(); return tx.hash;
    }));

    results.push(await runSamples("[v1] SPL_ERC20.transferFrom (self-allowance)", async () => {
        await (await v1Wusdc.approve(wallet.address, 100n, { gasLimit: 15_000_000n })).wait();
        const tx = await v1Wusdc.transferFrom(wallet.address, RECIPIENT, 1n, { gasLimit: 20_000_000n });
        await tx.wait(); return tx.hash;
    }));
    results.push(await runSamples("[v2] SPL_ERC20.transferFrom (self-allowance)", async () => {
        await (await v2Wbench.approve(wallet.address, 100n, { gasLimit: 15_000_000n })).wait();
        const tx = await v2Wbench.transferFrom(wallet.address, RECIPIENT, 1n, { gasLimit: 20_000_000n });
        await tx.wait(); return tx.hash;
    }));

    results.push(await runSamples("[v1] SPL_ERC20.bridgeOutToSolana", async () => {
        const tx = await v1Wusdc.bridgeOutToSolana(SOLANA_DEST, 1n, { gasLimit: 25_000_000n });
        await tx.wait(); return tx.hash;
    }));
    results.push(await runSamples("[v2] SPL_ERC20.bridgeOutToSolana", async () => {
        const tx = await v2Wbench.bridgeOutToSolana(SOLANA_DEST, 1n, { gasLimit: 25_000_000n });
        await tx.wait(); return tx.hash;
    }));

    results.push(await runSamples("[v1] RomeBridgeWithdraw.approveBurnETH", async (i) => {
        const tx = await v1Bridge.approveBurnETH(100n + BigInt(i), { gasLimit: 20_000_000n });
        await tx.wait(); return tx.hash;
    }));
    results.push(await runSamples("[v2] RomeBridgeWithdraw.approveBurnETH", async (i) => {
        const tx = await v2Bridge.approveBurnETH(100n + BigInt(i), { gasLimit: 20_000_000n });
        await tx.wait(); return tx.hash;
    }));

    results.push(await runSamples("[v1] RomeBridgeWithdraw.burnETH", async () => {
        await (await v1Bridge.approveBurnETH(1000n, { gasLimit: 20_000_000n })).wait();
        const tx = await v1Bridge.burnETH(1n, ETH_RECIPIENT, { gasLimit: 25_000_000n });
        await tx.wait(); return tx.hash;
    }));
    results.push(await runSamples("[v2] RomeBridgeWithdraw.burnETH", async () => {
        await (await v2Bridge.approveBurnETH(1000n, { gasLimit: 20_000_000n })).wait();
        const tx = await v2Bridge.burnETH(1n, ETH_RECIPIENT, { gasLimit: 25_000_000n });
        await tx.wait(); return tx.hash;
    }));

    results.push(await runSamples("[v1] RomeBridgeWithdraw.burnUSDC", async () => {
        const tx = await v1Bridge.burnUSDC(1n, ETH_RECIPIENT, { gasLimit: 25_000_000n });
        await tx.wait(); return tx.hash;
    }));
    results.push(await runSamples("[v2] RomeBridgeWithdraw.burnUSDC", async () => {
        const tx = await v2Bridge.burnUSDC(1n, ETH_RECIPIENT, { gasLimit: 25_000_000n });
        await tx.wait(); return tx.hash;
    }));

    results.push(await runSamples("[v1] ERC20SPLFactory.create_token_mint", async () => {
        const tx = await v1Factory.create_token_mint({ gasLimit: 20_000_000n });
        await tx.wait(); return tx.hash;
    }));
    results.push(await runSamples("[v2] ERC20SPLFactory.create_token_mint", async () => {
        const tx = await v2Factory.create_token_mint({ gasLimit: 20_000_000n });
        await tx.wait(); return tx.hash;
    }));

    results.push(await runSamples("[v1] ERC20SPLFactory.init_token_mint", async () => {
        const [mintToInit] = await v1Factory.get_current_mint(wallet.address) as [string, string];
        await (await v1Factory.create_token_mint({ gasLimit: 20_000_000n })).wait();
        const tx = await v1Factory.init_token_mint(mintToInit, { gasLimit: 20_000_000n });
        await tx.wait(); return tx.hash;
    }));
    results.push(await runSamples("[v2] ERC20SPLFactory.init_token_mint", async () => {
        const [mintToInit] = await v2Factory.get_current_mint(wallet.address) as [string, string];
        await (await v2Factory.create_token_mint({ gasLimit: 20_000_000n })).wait();
        const tx = await v2Factory.init_token_mint(mintToInit, { gasLimit: 20_000_000n });
        await tx.wait(); return tx.hash;
    }));

    const out = {
        network: "hadrian", chainId: 200010, runAt: new Date().toISOString(),
        methodology: "submit production-contract tx -> rome_solanaTxForEvmTx -> Solana getTransaction -> meta.computeUnitsConsumed",
        deployer: wallet.address, v1Addresses: v1, v2Addresses: v2, results,
    };
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 2) + "\n");

    console.log("\n" + "=".repeat(96));
    console.log("REAL-FLOW CU RESULTS (Hadrian, mean of 3 samples)");
    console.log("=".repeat(96));
    for (const r of results) {
        const m = typeof r.mean === "number" ? r.mean.toLocaleString().padStart(10) + " CU" : "n/a".padStart(10);
        console.log(`${r.label.padEnd(58)} ${m}`);
    }
    console.log(`\nResults: ${RESULTS_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
