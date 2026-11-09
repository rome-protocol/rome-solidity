// scripts/erc20spl/deploy-named-factory.ts
//
// Deploys the named wrapper factory (ERC20SPLNamedFactory) on a chain. It has no owner and no upgrade: its only
// inputs are the CPI precompile's address and the grandfather list (the mints that already have a token on the
// chain under an old name, so the factory refuses to make another).
//
// A DRY RUN is the default and sends nothing: it prints the deploy data's hash, the constructor call decoded back
// from that data, the grandfather hash, the deployer's pending nonce, the address the deploy would create, and a
// gas estimate (a deploy that would revert fails the dry run). `--send` deploys, and needs
// `--expect-nonce <n>`, the deployer's current transaction count, pending included, which must equal the chain's,
// and `--expect-grandfather-hash <hash>`, which must equal the list's hash; on a mainnet chain it also needs
// `--i-understand-mainnet`, and `--no-grandfather` is refused. The send carries the nonce it was gated on. The
// record goes to deployments/<network>.json under ERC20SPLNamedFactory with `live: false` as soon as the receipt
// is in, then the script reads everything back (the CPI address, the grandfather hash, each listed mint, the
// helper contracts) and fails loudly on any difference. `live` is set by hand, in the same change as the chain's
// registry record. If a record already exists the script only reads it back and sends nothing.
//
//   npx tsx scripts/erc20spl/deploy-named-factory.ts --network <name> --grandfather list.json
//   npx tsx scripts/erc20spl/deploy-named-factory.ts --network <name> --grandfather list.json --send \
//       --expect-nonce <n> --expect-grandfather-hash <hash>
//
// The grandfather list is JSON: [{ "network": <chain id>, "mint": "<base58>", "wrapper": "0x..." }, ...];
// `--no-grandfather` deploys with an empty list (not on a mainnet chain). The deploy key is the one behind the
// network in hardhat.config.ts (the keystore or the environment); it is never an argument and never printed.

import fs from "node:fs";
import hardhat from "hardhat";
import { getContractAddress, getAddress } from "viem";
import { readDeployments, writeDeployments } from "../lib/deployments.js";
import { MAINNET_CHAIN_IDS } from "../bridge/lib/testnet-guard.js";
import { assertListAllowed, buildDeploy, gateSend, grandfatherHash, parseGrandfatherList, planDeploy, type GrandfatherEntry } from "./lib/named-factory-deploy.js";

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
    assertListAllowed({ noGrandfather: flag("--no-grandfather"), mainnet: MAINNET_CHAIN_IDS.has(chainId) });
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

    // The pending count: a transaction already waiting in the pool moves the deploy's nonce, and so its address.
    const nonce = await publicClient.getTransactionCount({ address: deployer, blockTag: "pending" });
    const predicted = getContractAddress({ from: deployer, nonce: BigInt(nonce) });
    const artifact = await hardhat.artifacts.readArtifact("ERC20SPLNamedFactory");
    const built = buildDeploy({ abi: artifact.abi as any, bytecode: artifact.bytecode as `0x${string}`, args: plan.args });
    console.log(built.lines.join("\n"));
    console.log(`deployer nonce ${nonce} (pending included); the deploy would create ${predicted}`);
    // Simulate the deploy: a revert fails the dry run too.
    const gas = await publicClient.estimateGas({ account: deployer, data: built.data });
    console.log(`gas estimate ${gas}`);
    const mode = gateSend({
        send: flag("--send"),
        expectNonce: value("--expect-nonce") === undefined ? undefined : Number(value("--expect-nonce")),
        nonce,
        mainnet: MAINNET_CHAIN_IDS.has(chainId),
        acknowledgeMainnet: flag("--i-understand-mainnet"),
        grandfatherHash: hash,
        expectGrandfatherHash: value("--expect-grandfather-hash"),
    });
    if (mode === "dry-run") {
        console.log(
            `DRY RUN: nothing sent. Run again with --send --expect-nonce ${nonce} --expect-grandfather-hash ${hash} to deploy.`,
        );
        return;
    }

    // The nonce is passed, so the send lands at the nonce the gate checked and at the address printed above.
    const txHash = await wallet.sendTransaction({ account: wallet.account, data: built.data, nonce, gas } as any);
    console.log(`deploy tx ${txHash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy failed: ${txHash}`);
    // Record at once, before any readback: a failure after a landed deploy must not leave a second deploy to be made.
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
    if (getAddress(receipt.contractAddress) !== getAddress(predicted)) {
        throw new Error(`deployed at ${receipt.contractAddress}, not the predicted ${predicted}`);
    }
    await readBack(viem, publicClient, getAddress(receipt.contractAddress), list, hash);
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
