/**
 * P3.1 — Measure find_program_address vs pdas_batch_derive Solana CU cost.
 *
 * Deploys `PdaCostProbe` to whatever Rome chain is in `--network <chain>`,
 * then calls each probe function via `rome_emulateTx` to capture
 * `computeUnitsConsumed` from the Solana tx receipt the proxy would have
 * produced. Three probes give us the per-hop and batched costs.
 *
 * Usage:
 *   npx hardhat run scripts/cpi/measure-pda-cost.ts --network marcus
 *   npx hardhat run scripts/cpi/measure-pda-cost.ts --network aurelius
 *
 * The script is read-only at the rome_emulateTx layer — no real on-chain
 * txs are submitted (other than the one-time probe deploy). It writes
 * `deployments/<network>.PdaCostProbe.json` with the deployed address so
 * subsequent runs reuse the same instance.
 *
 * Output: a table of compute units per probe + the per-hop / batched
 * delta. If the 7-PDA batched savings exceeds the 50K CU threshold from
 * the P3.1 spec, we proceed to P3.2 (BatchPdaDeriver library).
 */
import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";
import {
    Wallet,
    JsonRpcProvider,
    ContractFactory,
    Interface,
} from "ethers";
import probeArtifact from "../../artifacts/contracts/cpi/test/PdaCostProbe.sol/PdaCostProbe.json" with { type: "json" };

interface EmulateResult {
    computeUnitsConsumed?: number;
    [key: string]: unknown;
}

const SAMPLES = 3; // 3-sample average, matches rome-evm-private/CLAUDE.md convention.

async function rome_emulateTx(rpcUrl: string, signedTx: string): Promise<EmulateResult> {
    const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "rome_emulateTx",
            params: [signedTx],
        }),
    });
    const body = (await res.json()) as { result?: EmulateResult; error?: { message: string } };
    if (body.error) {
        throw new Error(`rome_emulateTx failed: ${body.error.message}`);
    }
    return body.result ?? {};
}

async function main() {
    const { networkConfig, networkName } = await hardhat.network.connect();
    const urlField = (networkConfig as any).url;
    const url: string = typeof urlField === "string"
        ? urlField
        : (typeof urlField?.get === "function" ? await urlField.get() : String(urlField));
    const pk = await (networkConfig as any).accounts[0].get();
    const chainId = (networkConfig as any).chainId as number;

    const provider = new JsonRpcProvider(url);
    const wallet = new Wallet(pk, provider);

    console.log(`Network: ${networkName} (chainId=${chainId})`);
    console.log(`Signer:  ${wallet.address}`);
    console.log(`RPC:     ${url}\n`);

    // 1. Deploy or load probe.
    const deploymentFile = path.join(
        process.cwd(),
        "deployments",
        `${networkName}.PdaCostProbe.json`
    );

    let probeAddress: string;
    if (fs.existsSync(deploymentFile)) {
        const existing = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
        probeAddress = existing.address;
        console.log(`Probe (cached): ${probeAddress}\n`);
    } else {
        console.log("Probe not yet deployed on this chain. Deploying...");
        const factory = new ContractFactory(
            probeArtifact.abi,
            probeArtifact.bytecode,
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
        console.log(`Probe deployed: ${probeAddress}\n`);
    }

    // 2. Build calldata for each probe.
    const iface = new Interface(probeArtifact.abi);
    const probes: Array<{ name: string; data: string; expectedPdas: number; method: string }> = [
        {
            name: "probeOnePda (baseline)",
            method: "probeOnePda",
            expectedPdas: 1,
            data: iface.encodeFunctionData("probeOnePda", [1n]),
        },
        {
            name: "probeSevenIndividual",
            method: "probeSevenIndividual",
            expectedPdas: 7,
            data: iface.encodeFunctionData("probeSevenIndividual", [100n]),
        },
        {
            name: "probeSevenBatched",
            method: "probeSevenBatched",
            expectedPdas: 7,
            data: iface.encodeFunctionData("probeSevenBatched", [200n]),
        },
    ];

    // 3. Emulate each, capture CU.
    const gasPrice = (await provider.getFeeData()).gasPrice ?? 5_000_000_000n;
    const results: Array<{ name: string; samples: (number | string)[]; mean: number | string }> = [];

    for (const p of probes) {
        const samples: (number | string)[] = [];
        for (let i = 0; i < SAMPLES; i++) {
            const nonce = await provider.getTransactionCount(wallet.address);
            const signed = await wallet.signTransaction({
                chainId,
                nonce,
                gasPrice,
                gasLimit: 3_000_000n,
                to: probeAddress,
                value: 0n,
                data: p.data,
                type: 0,
            });
            try {
                const result = await rome_emulateTx(url, signed);
                const cu = result.computeUnitsConsumed;
                samples.push(typeof cu === "number" ? cu : `(no CU field in response — keys: ${Object.keys(result).join(", ")})`);
            } catch (e: any) {
                samples.push(`ERR: ${e.message}`);
            }
        }
        const numeric = samples.filter((s): s is number => typeof s === "number");
        const mean = numeric.length > 0 ? Math.round(numeric.reduce((a, b) => a + b, 0) / numeric.length) : "n/a";
        results.push({ name: p.name, samples, mean });
    }

    // 4. Report.
    console.log("\nResults (3 samples per probe):");
    console.log("─".repeat(80));
    for (const r of results) {
        console.log(`${r.name.padEnd(28)} samples=${JSON.stringify(r.samples)} mean=${r.mean}`);
    }

    // 5. Decision.
    const oneMean = results[0].mean;
    const sevenIndMean = results[1].mean;
    const sevenBatMean = results[2].mean;
    if (typeof oneMean === "number" && typeof sevenIndMean === "number" && typeof sevenBatMean === "number") {
        const perHopFromOne = oneMean;
        const perHopFromSeven = Math.round(sevenIndMean / 7);
        const savings = sevenIndMean - sevenBatMean;
        console.log("\nAnalysis:");
        console.log(`  per-hop (from baseline)  : ~${perHopFromOne.toLocaleString()} CU`);
        console.log(`  per-hop (from 7-ind avg) : ~${perHopFromSeven.toLocaleString()} CU`);
        console.log(`  7 individual             : ${sevenIndMean.toLocaleString()} CU`);
        console.log(`  7 batched                : ${sevenBatMean.toLocaleString()} CU`);
        console.log(`  Savings (7-ind - 7-bat)  : ${savings.toLocaleString()} CU`);
        console.log("");
        if (savings >= 50_000) {
            console.log(`  ✅ Savings exceed 50K CU threshold — proceed to P3.2 (BatchPdaDeriver library).`);
        } else if (savings > 0) {
            console.log(`  ⚠ Savings positive but below 50K CU threshold — BatchPdaDeriver scope is marginal.`);
        } else {
            console.log(`  ❌ No savings (or negative) — scrap BatchPdaDeriver.`);
        }
    } else {
        console.log("\nNumeric analysis skipped — rome_emulateTx response did not surface computeUnitsConsumed in at least one probe. Inspect the raw samples above to identify the right field.");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
