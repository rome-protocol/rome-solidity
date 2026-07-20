/**
 * Comprehensive primitive CU measurement.
 *
 * METHODOLOGY:
 *   Each probe is submitted as a REAL EVM tx → resolved to Solana sig via
 *   `rome_solanaTxForEvmTx` → `meta.computeUnitsConsumed` from Solana RPC.
 *   3 samples per probe, mean reported.
 *
 *   Tier 1 (no setup) — PDA/ATA derivation, account reads, batch derive.
 *   Tier 2 (requires setup) — wrap, unwrap, SPL transfer variants.
 *
 *   Tier 2 setup:
 *     1. Transfer gas to probe contract (~0.05 USDC native gas)
 *     2. Call probe.setup(deployerAddress, 1e16 wei) — activates probe's PDA,
 *        creates ATAs, wraps starter balance.
 *     3. Subsequent probes use the established state.
 *
 * Usage:
 *   npx hardhat run scripts/cpi/measure-all-primitives.ts --network hadrian
 */
import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";
import {
    Wallet,
    JsonRpcProvider,
    ContractFactory,
    Contract,
    Interface,
} from "ethers";
import benchArtifact from "../../artifacts/contracts/cpi/test/BenchProbe.sol/BenchProbe.json" with { type: "json" };

const SAMPLES = 3;
const SETUP_GAS_TRANSFER_WEI = 50_000_000_000_000_000n;       // 0.05 USDC native gas to probe
const SETUP_INITIAL_WRAP_WEI = 10_000_000_000_000_000n;       // 0.01 USDC wrapped into probe ATA

async function rome_solanaTxForEvmTx(rpcUrl: string, evmHash: string): Promise<string[]> {
    const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "rome_solanaTxForEvmTx",
            params: [evmHash],
        }),
    });
    const body = (await res.json()) as { result?: string[]; error?: { message: string } };
    if (body.error) throw new Error(`rome_solanaTxForEvmTx failed: ${body.error.message}`);
    return body.result ?? [];
}

async function getSolanaCu(solanaRpc: string, sig: string): Promise<number> {
    const res = await fetch(solanaRpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
        }),
    });
    const body = (await res.json()) as { result?: { meta?: { computeUnitsConsumed?: number } } };
    return body.result?.meta?.computeUnitsConsumed ?? 0;
}

async function totalCuForEvmTx(rpcUrl: string, solanaRpc: string, evmHash: string): Promise<{ sigs: string[]; totalCu: number; perTx: number[] }> {
    let sigs: string[] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
        sigs = await rome_solanaTxForEvmTx(rpcUrl, evmHash);
        if (sigs.length > 0) break;
        await new Promise(r => setTimeout(r, 2000));
    }
    if (sigs.length === 0) throw new Error(`rome_solanaTxForEvmTx returned empty after 60s for ${evmHash}`);
    const perTx: number[] = [];
    for (const sig of sigs) {
        let cu = 0;
        for (let attempt = 0; attempt < 10; attempt++) {
            cu = await getSolanaCu(solanaRpc, sig);
            if (cu > 0) break;
            await new Promise(r => setTimeout(r, 1500));
        }
        perTx.push(cu);
    }
    return { sigs, perTx, totalCu: perTx.reduce((a, b) => a + b, 0) };
}

interface ProbeSpec {
    label: string;
    method: string;
    args: unknown[];
    group: string;
    pairWith?: string;
    /** Tier 2 probes need setup() done first. */
    tier: 1 | 2;
}

async function main() {
    const { networkConfig, networkName } = await hardhat.network.connect();
    const urlField = (networkConfig as any).url;
    const url: string = typeof urlField === "string"
        ? urlField
        : (typeof urlField?.get === "function" ? await urlField.get() : String(urlField));
    const pk = await (networkConfig as any).accounts[0].get();
    const chainId = (networkConfig as any).chainId as number;

    const solanaRpc = chainId === 30001
        ? "https://api.testnet.solana.com/"          // Aurelius
        : "https://api.devnet.solana.com/";          // Hadrian / Marcus

    const provider = new JsonRpcProvider(url);
    const wallet = new Wallet(pk, provider);

    console.log(`Network:    ${networkName} (chainId=${chainId})`);
    console.log(`Signer:     ${wallet.address}`);
    console.log(`EVM RPC:    ${url}`);
    console.log(`Solana RPC: ${solanaRpc}\n`);

    // 1. Deploy or reuse BenchProbe.
    const deploymentFile = path.join(
        process.cwd(),
        "deployments",
        `${networkName}.BenchProbe.json`
    );
    let probeAddress: string;
    if (fs.existsSync(deploymentFile)) {
        const existing = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
        probeAddress = existing.address;
        console.log(`BenchProbe (cached): ${probeAddress}\n`);
    } else {
        console.log("Deploying BenchProbe...");
        const factory = new ContractFactory(
            benchArtifact.abi,
            benchArtifact.bytecode,
            wallet
        );
        const probe = await factory.deploy();
        await probe.waitForDeployment();
        probeAddress = await probe.getAddress();
        fs.mkdirSync(path.dirname(deploymentFile), { recursive: true });
        fs.writeFileSync(
            deploymentFile,
            JSON.stringify({ address: probeAddress, deployedAt: new Date().toISOString() }, null, 2)
        );
        console.log(`BenchProbe deployed: ${probeAddress}\n`);
    }

    const probe = new Contract(probeAddress, benchArtifact.abi, wallet);
    const iface = new Interface(benchArtifact.abi);

    // 2. Setup state for Tier 2 probes if not already done.
    let setupDone = false;
    try {
        setupDone = await probe.setupDone();
    } catch (e: any) {
        // Older ABI — assume not done
        setupDone = false;
    }
    if (!setupDone) {
        console.log("Tier 2 setup not done. Calling setup(dest, initialWrapWei) with msg.value...");
        const setupTx = await probe.setup(wallet.address, SETUP_INITIAL_WRAP_WEI, {
            value: SETUP_GAS_TRANSFER_WEI,
            gasLimit: 15_000_000n,
        });
        await setupTx.wait();
        console.log(`  setup tx: ${setupTx.hash}\n`);
    } else {
        console.log("Tier 2 setup already done.\n");
    }

    // 3. Resolve runtime values.
    console.log("Resolving chain runtime values...");
    const mintIdHex: string = await probe.probe_mintId();
    const operatorHex: string = await probe.probe_operator();
    console.log(`  mint_id:  ${mintIdHex}`);
    console.log(`  operator: ${operatorHex}\n`);

    // 4. Probe specs.
    const probes: ProbeSpec[] = [
        // Tier 1 — Baseline dispatch overhead
        { label: "[baseline] probe_mintId",                                       method: "probe_mintId",                       args: [],                              group: "baseline", tier: 1 },
        { label: "[baseline] probe_operator",                                     method: "probe_operator",                     args: [],                              group: "baseline", tier: 1 },

        // Tier 1 — PDA derivation
        { label: "OLD findPda × 1 (single derive)",                               method: "probe_findPda_single",               args: [42n],                           group: "pda", tier: 1 },
        { label: "OLD findPda × 2 (two-hop ATA path)",                            method: "probe_findPda_twoHop",               args: [42n],                           group: "pda", tier: 1, pairWith: "OLD findPda × 1 (single derive)" },
        { label: "NEW HelperProgram.pda(user)",                                   method: "probe_helperPda",                    args: [wallet.address],                group: "pda", tier: 1, pairWith: "OLD findPda × 1 (single derive)" },
        { label: "NEW HelperProgram.ata(user, mint)",                             method: "probe_helperAta",                    args: [wallet.address, mintIdHex],     group: "ata", tier: 1, pairWith: "OLD findPda × 2 (two-hop ATA path)" },

        // Tier 1 — Batch derive
        { label: "OLD findPda × 7 (sequential)",                                  method: "probe_findPda_7sequential",          args: [100n],                          group: "batch", tier: 1 },
        { label: "NEW pdas_batch_derive × 7",                                     method: "probe_pdasBatch_7",                  args: [200n],                          group: "batch", tier: 1, pairWith: "OLD findPda × 7 (sequential)" },

        // Tier 1 — Account reads
        { label: "OLD account_info (full marshal)",                               method: "probe_accountInfo",                  args: [mintIdHex],                     group: "account", tier: 1 },
        { label: "NEW account_data_at (slice 0..82)",                             method: "probe_accountDataAt",                args: [mintIdHex, 0, 82],              group: "account", tier: 1, pairWith: "OLD account_info (full marshal)" },
        { label: "NEW account_u64_at (offset 36)",                                method: "probe_accountU64At",                 args: [mintIdHex, 36],                 group: "account", tier: 1, pairWith: "OLD account_info (full marshal)" },
        { label: "NEW account_lamports",                                          method: "probe_accountLamports",              args: [mintIdHex],                     group: "account", tier: 1, pairWith: "OLD account_info (full marshal)" },

        // Tier 2 — Mutations (requires setup)
        { label: "[T2] Wrap NEW (Withdraw.withdraw_to_ata)",                      method: "probe_wrap_new",                     args: [100_000_000_000_000n],          group: "wrap", tier: 2 },
        { label: "[T2] Unwrap NEW (HelperProgram.deposit_from_ata)",              method: "probe_unwrap_new",                   args: [100_000_000_000_000n],          group: "wrap", tier: 2 },
        { label: "[T2] SPL transfer NEW 3-arg (addr)",                            method: "probe_transfer_spl_helper_3arg",     args: [],                              group: "transfer", tier: 2 },
        { label: "[T2] SPL transfer NEW 4-arg delegate",                          method: "probe_transfer_spl_helper_4arg",     args: [],                              group: "transfer", tier: 2, pairWith: "[T2] SPL transfer LEGACY (SplTokenLib + invoke)" },
        { label: "[T2] SPL transfer LEGACY (SplTokenLib + invoke)",               method: "probe_transfer_spl_legacy",          args: [],                              group: "transfer", tier: 2 },

        // Tier 3 — Universal-delegation (the Rome EVM program #364, A1-A6)
        // Side-by-side v1 (multi-call) vs new (single-dispatch precompile)
        { label: "[T3] A3 OLD pda_with_salt (rome_evm_program_id + find_program_address)", method: "probe_a3_pdaWithSalt_OLD",            args: [wallet.address, "0x" + "11".repeat(32)],            group: "salted-pda", tier: 3 },
        { label: "[T3] A3 NEW HelperProgram.pda_with_salt",                       method: "probe_a3_pdaWithSalt_NEW",           args: [wallet.address, "0x" + "11".repeat(32)],            group: "salted-pda", tier: 3, pairWith: "[T3] A3 OLD pda_with_salt (rome_evm_program_id + find_program_address)" },
        { label: "[T3] A2 OLD approve (SplTokenLib.approve + invoke_signed)",     method: "probe_a2_approveSplRawDelegate_OLD", args: ["0x" + "22".repeat(32), 1n],                       group: "approve", tier: 3 },
        { label: "[T3] A2 NEW HelperProgram.approve_spl_raw_delegate",            method: "probe_a2_approveSplRawDelegate_NEW", args: ["0x" + "22".repeat(32), 1n, 6],                    group: "approve", tier: 3, pairWith: "[T3] A2 OLD approve (SplTokenLib.approve + invoke_signed)" },
    ];

    // 5. Run probes.
    const results: Array<{
        label: string;
        group: string;
        tier: number;
        pairWith?: string;
        samples: Array<{ evmHash: string; sigs: string[]; perTx: number[]; totalCu: number }>;
        mean: number | "n/a";
    }> = [];

    for (const p of probes) {
        console.log(`Probing: ${p.label}`);
        const data = iface.encodeFunctionData(p.method, p.args);
        const samples: Array<{ evmHash: string; sigs: string[]; perTx: number[]; totalCu: number }> = [];
        for (let i = 0; i < SAMPLES; i++) {
            try {
                const tx = await wallet.sendTransaction({
                    to: probeAddress,
                    data,
                    gasLimit: 5_000_000n,
                    type: 0,
                });
                await tx.wait();
                const r = await totalCuForEvmTx(url, solanaRpc, tx.hash);
                console.log(`  sample ${i+1}/${SAMPLES}: evmTx=${tx.hash.slice(0,10)}... sigs=${r.sigs.length} totalCu=${r.totalCu.toLocaleString()}`);
                samples.push({ evmHash: tx.hash, sigs: r.sigs, perTx: r.perTx, totalCu: r.totalCu });
            } catch (e: any) {
                console.log(`  sample ${i+1}/${SAMPLES}: ERR ${e.message?.slice(0, 100)}`);
                samples.push({ evmHash: "", sigs: [], perTx: [], totalCu: 0 });
            }
        }
        const valid = samples.filter(s => s.totalCu > 0).map(s => s.totalCu);
        const mean = valid.length > 0
            ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length)
            : "n/a" as const;
        results.push({ label: p.label, group: p.group, tier: p.tier, pairWith: p.pairWith, samples, mean });
        console.log();
    }

    // 6. Report.
    console.log("\n" + "═".repeat(120));
    console.log("CU MEASUREMENT RESULTS — Solana computeUnitsConsumed, mean across non-error samples");
    console.log("═".repeat(120));

    const meanOf = (label: string): number | undefined => {
        const r = results.find(x => x.label === label);
        return typeof r?.mean === "number" ? r.mean : undefined;
    };

    let lastGroup = "";
    for (const r of results) {
        if (r.group !== lastGroup) {
            console.log(`\n─── ${r.group.toUpperCase()} ───`);
            lastGroup = r.group;
        }
        const meanStr = typeof r.mean === "number" ? r.mean.toLocaleString().padStart(10) + " CU" : String(r.mean).padStart(13);
        let delta = "";
        if (r.pairWith) {
            const base = meanOf(r.pairWith);
            if (base !== undefined && typeof r.mean === "number") {
                const diff = r.mean - base;
                const pct = ((diff / base) * 100).toFixed(1);
                const sign = diff < 0 ? "−" : "+";
                delta = `   ${sign}${Math.abs(diff).toLocaleString()} CU (${pct}%) vs paired`;
            }
        }
        console.log(`${r.label.padEnd(60)} ${meanStr}${delta}`);
    }
    console.log("\n" + "═".repeat(120));

    // 7. Persist artifact.
    const artifactPath = path.join(
        process.cwd(),
        "deployments",
        `${networkName}.BenchProbe.bench.json`
    );
    fs.writeFileSync(artifactPath, JSON.stringify({
        network: networkName,
        chainId,
        probeAddress,
        mintId: mintIdHex,
        operator: operatorHex,
        solanaRpc,
        runAt: new Date().toISOString(),
        methodology: "submit probe tx → rome_solanaTxForEvmTx → Solana getTransaction → meta.computeUnitsConsumed",
        results,
    }, null, 2));
    console.log(`\nArtifact: ${artifactPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
