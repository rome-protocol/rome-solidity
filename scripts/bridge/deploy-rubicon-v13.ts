// scripts/bridge/deploy-rubicon-v13.ts
//
// The Rubicon (mainnet, chain 7531) deploy of RomeBridgeWithdraw 13.0.0.
// The owner and the guardian are set in the constructor, so nothing is handed over
// afterwards and the hot deploy key ends the deploy with no role.
//
//   - OWNER    = the cold Ledger address (--owner). It signs the owner calls below.
//   - GUARDIAN = the ops key address (--guardian), the stop-only key.
//   - The deploy key is the hot key behind the `rubicon` network in hardhat.config.ts
//     (RUBICON_PRIVATE_KEY, from the Hardhat keystore or the environment). It is
//     never printed. It must differ from the owner and the guardian.
//
// Both addresses are required and there are no defaults. Rubicon needs
// --i-understand-mainnet, always, and on Rubicon a run is a DRY RUN unless it is given
// --deploy <digest>, the digest the dry run printed (it covers the bytecode, the constructor
// arguments, the chain and the deploy key, so the real deploy sends exactly what was read):
//
//   export RUBICON_GAS_PRICE=$(( $(cast gas-price -r <rpc>) * 11 / 10 ))
//   npx hardhat compile
//   npx tsx scripts/bridge/deploy-rubicon-v13.ts --network rubicon \
//       --owner <ledger> --guardian <ops key> --i-understand-mainnet
//   npx tsx scripts/bridge/deploy-rubicon-v13.ts --network rubicon \
//       --owner <ledger> --guardian <ops key> --i-understand-mainnet --deploy <digest>
//
// The dry run estimates gas at the pinned gas price and prints the deploy transaction, the
// constructor arguments, the source commit and the digest. It sends nothing. On Rubicon the
// owner and guardian must be EIP-55 checksummed accounts with no code, the owner must hold
// gas, contracts/ must be clean, and RUBICON_GAS_PRICE must be set. A real run deploys, reads
// back VERSION, owner, pendingOwner, guardian, the empty CCTP list, the unpaused rails, the
// USDC wrapper and mint, the empty Wormhole lists and the deploy key's lack of any role (with
// retries for RPC lag), and fails loudly on any mismatch (and then writes nothing). It writes
// the address, the commit and the bytecode hash to deployments/rubicon.json under
// RomeBridgeWithdrawV13, next to the live v12 record, which it does not touch. Then it
// PRINTS the two owner calls the Ledger signs (ensureBridgeAta(<Rubicon USDC mint>) first,
// then enableCctpDomain(0, 1)); it never sends them.
//
// If the deploy landed but the read-back or the file write failed, do not deploy again:
//   ... --i-understand-mainnet --verify-existing <address> --deploy-tx <hash>
// checks that the transaction is the deploy key's creation of that address with exactly
// these bytes, reads it back, records it and prints the owner calls. It sends nothing.
//
// This is the ONE script with an exception to lib/testnet-guard.ts: it may touch chain
// 7531, and only with --i-understand-mainnet, only when the process was started as this
// file (the guard checks argv[1]), and its send step calls the guard itself. Every other
// script still refuses 7531. The same script runs on a testnet or a local Hardhat chain for
// rehearsal, with no flag.

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import hardhat from "hardhat";
import { encodeDeployData, keccak256 } from "viem";
import {
  READ_ABI, USAGE, parseArgs, runRubiconV13Deploy,
  type DeployDeps, type DeployOptions, type DeploymentStore,
} from "./lib/rubicon-v13.js";
import { assertRubiconV13DeploySend } from "./lib/testnet-guard.js";

/** This file's repo-relative path, as the guard compares it. A copy under another name is refused on mainnet. */
const SELF = path.relative(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), fileURLToPath(import.meta.url)).split(path.sep).join("/");

/** A deployments file, read and written the way scripts/lib/deployments.ts does. */
export function fileStore(file: string): DeploymentStore {
  return {
    read: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}),
    write: (data) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
    },
  };
}

/** The pinned gas price of a network config, when it has one (a number or a bigint, not "auto"). */
function pinnedGasPrice(config: any): bigint | undefined {
  const g = config?.gasPrice;
  return typeof g === "bigint" ? g : typeof g === "number" && Number.isFinite(g) ? BigInt(g) : undefined;
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), encoding: "utf8" }).trim();
}

/**
 * Wires runRubiconV13Deploy to a Hardhat network connection. Nothing is sent until the flow
 * asks, and the one send (`deploy`) asks the guard itself, with the operator's flag, so it is
 * never reachable unguarded. Only this file and its test import this module (a test scans for
 * any other importer), and the guard also requires that the process was started as this file.
 */
export async function depsFromConnection(
  connection: { viem: any; networkName: string; networkConfig?: any },
  store: DeploymentStore,
  log: (line: string) => void = console.log,
): Promise<DeployDeps> {
  const { viem, networkName } = connection;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  if (!wallet) throw new Error(`[${networkName}] no deploy key: set RUBICON_PRIVATE_KEY (or the network's key) in the Hardhat keystore or the environment`);
  const artifact = await hardhat.artifacts.readArtifact("RomeBridgeWithdraw");
  const abi = artifact.abi;
  const bytecode = artifact.bytecode as `0x${string}`;
  const deployer = wallet.account.address as `0x${string}`;
  const pinned = pinnedGasPrice(connection.networkConfig);
  // The guard reads the chain id the RPC reports, never the network's name.
  const guard = (mainnetFlag: boolean) =>
    assertRubiconV13DeploySend(publicClient, `${networkName} deploy RomeBridgeWithdraw 13.0.0`, { script: SELF, mainnetFlag });
  const deployData = (args: readonly unknown[]) => encodeDeployData({ abi, bytecode, args: [...args] as any });

  return {
    networkName,
    deployer,
    guard,
    store,
    deployData: (args) => deployData(args),
    estimate: async (args) => {
      const gas = (await publicClient.estimateGas({ account: deployer, data: deployData(args) })) as bigint;
      // The real deploy uses the network's pinned price; only without one is the RPC's price shown.
      const gasPrice = pinned ?? ((await publicClient.getGasPrice().catch(() => undefined)) as bigint | undefined);
      const balance = (await publicClient.getBalance({ address: deployer }).catch(() => undefined)) as bigint | undefined;
      return { gas, gasPrice, gasPricePinned: pinned !== undefined, balance };
    },
    deploy: async (args, mainnetFlag) => {
      // The send is never unguarded, whoever built these deps.
      await guard(mainnetFlag);
      const txHash = (await wallet.deployContract({ abi, bytecode, args: [...args] })) as `0x${string}`;
      let receipt: any;
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      } catch (e) {
        throw new Error(
          `[${networkName}] the deploy transaction ${txHash} was sent, but its receipt could not be read (${(e as Error).message.split("\n")[0]}). ` +
          "Do NOT deploy again: check the transaction, then re-run with --verify-existing <the address it created> --deploy-tx " + txHash,
        );
      }
      if (receipt.status !== "success" || !receipt.contractAddress) {
        throw new Error(`[${networkName}] the deploy transaction ${txHash} did not create a contract (status ${receipt.status})`);
      }
      return { address: receipt.contractAddress as `0x${string}`, txHash };
    },
    reader: (address) => ({
      read: (fn, args) => publicClient.readContract({ address, abi: READ_ABI, functionName: fn, args: args ? [...args] : undefined }),
      getCode: () => publicClient.getCode({ address }),
    }),
    accountInfo: async (address) => {
      const code = (await publicClient.getCode({ address })) as string | undefined;
      const balance = (await publicClient.getBalance({ address })) as bigint;
      return { hasCode: !!code && code !== "0x", balance };
    },
    source: async () => {
      let commit = "unknown";
      let contractsClean = false;
      try {
        commit = git(["rev-parse", "HEAD"]);
        contractsClean = git(["status", "--porcelain", "--", "contracts/"]) === "";
      } catch {
        // not a git checkout: unknown commit, and a mainnet run refuses (contractsClean stays false)
      }
      return { commit, contractsClean, bytecodeHash: keccak256(artifact.deployedBytecode as `0x${string}`) };
    },
    getDeployTx: async (hash) => {
      const tx = await publicClient.getTransaction({ hash }).catch(() => undefined);
      if (!tx) return undefined;
      const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => undefined);
      return { from: tx.from, input: tx.input, to: tx.to, status: receipt?.status ?? "pending", contractAddress: receipt?.contractAddress };
    },
    simulate: async (from, call) => {
      await publicClient.call({ account: from, to: call.to, data: call.data });
    },
    now: () => Date.now(),
    log,
  };
}

async function main() {
  // Arguments first: a missing owner or guardian, or Rubicon without the flag, stops here,
  // before any network connection exists.
  const opts: DeployOptions = parseArgs(process.argv.slice(2));
  const connection = await hardhat.network.connect(opts.network);
  const store = fileStore(path.resolve(process.cwd(), "deployments", `${connection.networkName}.json`));
  const deps = await depsFromConnection(connection, store);
  await runRubiconV13Deploy(deps, opts);
}

// Run only when this file is the entry point, so the tests can import the functions above.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    console.error(USAGE);
    process.exit(1);
  });
}
