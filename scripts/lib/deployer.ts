// Unified deployer for Rome contract deploys — cold Ledger or hot key.
//
//   DEPLOY_VIA_LEDGER=1            → sign with a connected Ledger (mainnet path)
//   DEPLOY_PRIVATE_KEY=0x...       → sign with a hot key (devnet/testnet / CI)
//
// Reads compiled artifacts straight from artifacts/ (run `npx hardhat compile`
// first), so it is runner-agnostic. The Ledger path MUST run under tsx
// (`npx tsx scripts/<x>.ts`), never `hardhat run` — Hardhat's CJS script runner
// hits an ESM require-cycle in @ledgerhq. The hot path runs under either.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { DEFAULT_LEDGER_PATH, makeLedgerDeployer, romeChain } from "./ledger.js";

export interface Deployer {
    address: Address;
    getBalance: () => Promise<bigint>;
    deploy: (contractName: string, args?: readonly unknown[]) => Promise<{ address: Address }>;
}

/** Recursively locate a compiled contract artifact (abi + deployable bytecode) by name. */
function findArtifact(name: string, root = "artifacts/contracts"): { abi: readonly unknown[]; bytecode: Hex } {
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            continue;
        }
        for (const entry of entries) {
            const p = join(dir, entry);
            if (statSync(p).isDirectory()) {
                stack.push(p);
            } else if (entry === `${name}.json` && !p.includes(".dbg.")) {
                const artifact = JSON.parse(readFileSync(p, "utf8"));
                if (artifact.bytecode && artifact.bytecode !== "0x") {
                    return { abi: artifact.abi, bytecode: artifact.bytecode as Hex };
                }
            }
        }
    }
    throw new Error(`No deployable artifact for ${name} under ${root} — run \`npx hardhat compile\` first`);
}

export async function getDeployer(chainId: number, rpcUrl: string): Promise<Deployer> {
    if (process.env.DEPLOY_VIA_LEDGER === "1") {
        const ledger = await makeLedgerDeployer(chainId, rpcUrl, process.env.LEDGER_PATH ?? DEFAULT_LEDGER_PATH);
        return {
            address: ledger.address,
            getBalance: ledger.getBalance,
            async deploy(name, args = []) {
                const { abi, bytecode } = findArtifact(name);
                return ledger.deploy(abi, bytecode, args);
            },
        };
    }

    const pk = process.env.DEPLOY_PRIVATE_KEY;
    if (!pk) {
        throw new Error("Set DEPLOY_VIA_LEDGER=1 (cold Ledger) or DEPLOY_PRIVATE_KEY=0x... (hot key)");
    }
    const { privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
    const chain = romeChain(chainId, rpcUrl);
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    return {
        address: account.address,
        getBalance: () => publicClient.getBalance({ address: account.address }),
        async deploy(name, args = []) {
            const { abi, bytecode } = findArtifact(name);
            const hash = await wallet.deployContract({ abi, bytecode, args } as never);
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            if (receipt.status !== "success" || !receipt.contractAddress) {
                throw new Error(`Deploy failed: ${name} (status=${receipt.status}, tx=${hash})`);
            }
            return { address: receipt.contractAddress as Address };
        },
    };
}
