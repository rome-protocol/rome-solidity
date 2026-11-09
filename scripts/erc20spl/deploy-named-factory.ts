// scripts/erc20spl/deploy-named-factory.ts
//
// Deploys the named wrapper factory (E1, ERC20SPLNamedFactory) on a chain. It has no owner and no upgrade: its
// only inputs are the CPI precompile's address and the grandfather list (the mints that already have a Rome
// token on the chain under an old name, so E1 refuses to make another), the same list the asset book takes.
//
// A DRY RUN is the default and sends nothing: it prints the decoded constructor call, the grandfather hash, the
// deployer's nonce, the address the deploy would create and the gas estimate. `--send` deploys, and needs
// `--expect-nonce <n>`, the deployer's current transaction count, which must equal the chain's; on a mainnet
// chain it also needs `--i-understand-mainnet`. After a send it reads everything back (the CPI address, the
// grandfather hash, each listed mint, the helper contracts) and fails loudly on any difference. The record goes
// to deployments/<network>.json under ERC20SPLNamedFactory with `live: false`: the lead sets `live` when the
// registry's record marks E1 the chain's live factory, never this script. If a record already exists the script
// only reads it back and sends nothing.
//
//   npx tsx scripts/erc20spl/deploy-named-factory.ts --network hadrian --grandfather list.json
//   npx tsx scripts/erc20spl/deploy-named-factory.ts --network hadrian --grandfather list.json --send --expect-nonce 12
//
// The grandfather list is JSON: [{ "network": 74, "mint": "<base58>", "wrapper": "0x..." }, ...]; `--no-grandfather`
// deploys with an empty list. The deploy key is the one behind the network in hardhat.config.ts (the keystore or
// the environment); it is never an argument and never printed. On Rubicon, pin the gas price first (see CLAUDE.md).

import fs from "node:fs";
import hardhat from "hardhat";
import { getContractAddress, getAddress } from "viem";
import { readDeployments, writeDeployments } from "../lib/deployments.js";
import { MAINNET_CHAIN_IDS } from "../bridge/lib/testnet-guard.js";
import { gateSend, grandfatherHash, parseGrandfatherList, planDeploy, type GrandfatherEntry } from "./lib/named-factory-deploy.js";

const CPI_PROGRAM = "0xFF00000000000000000000000000000000000008" as const;
const ZERO = "0x0000000000000000000000000000000000000000";

function flag(name: string): boolean {
    return process.argv.includes(name);
}
function value(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
    const networkName = value("--network") ?? process.env.HARDHAT_NETWORK;
    if (!networkName) throw new Error("--network <name> is required");

    let list: GrandfatherEntry[];
    if (flag("--no-grandfather")) {
        list = [];
    } else {
        const file = value("--grandfather");
        if (!file) throw new Error("--grandfather <file.json> is required (or --no-grandfather for an empty list)");
        list = parseGrandfatherList(JSON.parse(fs.readFileSync(file, "utf8")));
    }

    const { viem } = await hardhat.network.connect(networkName);
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    if (!wallet?.account) throw new Error(`no deployer account for ${networkName}: set its private key in the keystore`);
    const deployer = wallet.account.address;
    const chainId = await publicClient.getChainId();
    const dep = readDeployments(networkName);
    const plan = planDeploy({ cpiProgram: CPI_PROGRAM, list });
    const hash = grandfatherHash(list);

    console.log(`[${networkName}] chain ${chainId}; deployer ${deployer}`);
    console.log(plan.lines.join("\n"));

    // A record already there: read it back, send nothing.
    const recorded = dep.ERC20SPLNamedFactory?.address;
    if (recorded) {
        console.log(`[${networkName}] a record exists (${recorded}); reading it back, sending nothing.`);
        await readBack(viem, publicClient, getAddress(recorded), list, hash);
        return;
    }

    const nonce = await publicClient.getTransactionCount({ address: deployer });
    const predicted = getContractAddress({ from: deployer, nonce: BigInt(nonce) });
    const artifact = await hardhat.artifacts.readArtifact("ERC20SPLNamedFactory");
    console.log(`deployer nonce ${nonce}; the deploy would create ${predicted}`);
    const mode = gateSend({
        send: flag("--send"),
        expectNonce: value("--expect-nonce") === undefined ? undefined : Number(value("--expect-nonce")),
        nonce,
        mainnet: MAINNET_CHAIN_IDS.has(chainId),
        acknowledgeMainnet: flag("--i-understand-mainnet"),
    });
    if (mode === "dry-run") {
        console.log(`DRY RUN: nothing sent. Run again with --send --expect-nonce ${nonce} to deploy.`);
        return;
    }

    const txHash = await wallet.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode as `0x${string}`,
        args: [...plan.args],
        account: wallet.account,
    } as any);
    console.log(`deploy tx ${txHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy failed: ${txHash}`);
    if (getAddress(receipt.contractAddress) !== getAddress(predicted)) {
        throw new Error(`deployed at ${receipt.contractAddress}, not the predicted ${predicted}`);
    }
    await readBack(viem, publicClient, getAddress(receipt.contractAddress), list, hash);

    dep.ERC20SPLNamedFactory = {
        address: receipt.contractAddress,
        cpiContractAddress: CPI_PROGRAM,
        grandfatherHash: hash,
        live: false,
        deployTx: txHash,
        deployedAt: Math.floor(Date.now() / 1000),
    };
    writeDeployments(networkName, dep);
    console.log(`[${networkName}] recorded ERC20SPLNamedFactory ${receipt.contractAddress} (live: false) in deployments/${networkName}.json`);
}

/** Reads the deployed factory back and fails on any difference from what the plan said. */
async function readBack(viem: any, publicClient: any, address: `0x${string}`, list: GrandfatherEntry[], hash: `0x${string}`) {
    const code = await publicClient.getCode({ address });
    if (!code || code === "0x") throw new Error(`no code at ${address}`);
    const f = await viem.getContractAt("ERC20SPLNamedFactory", address);
    const checks: [string, unknown, unknown][] = [
        ["cpi_program()", getAddress(await f.read.cpi_program()), getAddress(CPI_PROGRAM)],
        ["grandfatherHash()", await f.read.grandfatherHash(), hash],
    ];
    for (const e of list) {
        checks.push([`grandfathered(${e.mint})`, getAddress(await f.read.grandfathered([e.mint])), getAddress(e.wrapper)]);
    }
    for (const [what, got, want] of checks) {
        const ok = got === want;
        console.log(`  ${ok ? "ok " : "BAD"} ${what} = ${got}`);
        if (!ok) throw new Error(`readback: ${what} is ${got}, expected ${want}`);
    }
    for (const getter of ["users", "hooked_wrapper_deployer"] as const) {
        const a = (await f.read[getter]()) as `0x${string}`;
        const c = await publicClient.getCode({ address: a });
        if (a === ZERO || !c || c === "0x") throw new Error(`readback: ${getter}() ${a} has no code`);
        console.log(`  ok  ${getter}() = ${a}`);
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
