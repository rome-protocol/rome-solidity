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
// --i-understand-mainnet, always, a dry run included. Run the dry run first:
//
//   export RUBICON_GAS_PRICE=$(( $(cast gas-price -r <rpc>) * 11 / 10 ))
//   npx hardhat compile
//   npx tsx scripts/bridge/deploy-rubicon-v13.ts --network rubicon \
//       --owner <ledger> --guardian <ops key> --i-understand-mainnet --dry-run
//   npx tsx scripts/bridge/deploy-rubicon-v13.ts --network rubicon \
//       --owner <ledger> --guardian <ops key> --i-understand-mainnet
//
// --dry-run estimates gas and prints the deploy transaction and the constructor
// arguments. It sends nothing. A real run deploys, reads back VERSION, owner,
// pendingOwner, guardian, the empty CCTP list, the unpaused rails, the USDC wrapper and
// mint, the empty Wormhole lists and the deploy key's lack of any role, and fails loudly
// on any mismatch (and then writes nothing). It writes the address to
// deployments/rubicon.json under RomeBridgeWithdrawV13, next to the live v12 record,
// which it does not touch. Then it PRINTS the two owner calls the Ledger signs
// (enableCctpDomain(0, 1) and ensureBridgeAta(<Rubicon USDC mint>)); it never sends them.
//
// This is the ONE script with an exception to lib/testnet-guard.ts: it may touch chain
// 7531, and only with --i-understand-mainnet. Every other script still refuses 7531.
// The same script runs on a testnet or a local Hardhat chain for rehearsal, with no flag.

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";
import hardhat from "hardhat";
import { encodeDeployData } from "viem";
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

/** Wires runRubiconV13Deploy to a Hardhat network connection. Nothing is sent until the flow asks. */
export async function depsFromConnection(
  connection: { viem: any; networkName: string },
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

  return {
    networkName,
    deployer,
    // The guard reads the chain id the RPC reports, never the network's name.
    guard: (mainnetFlag) => assertRubiconV13DeploySend(publicClient, `${networkName} deploy RomeBridgeWithdraw 13.0.0`, { script: SELF, mainnetFlag }),
    store,
    estimate: async (args) => {
      const data = encodeDeployData({ abi, bytecode, args: [...args] });
      const gas = (await publicClient.estimateGas({ account: deployer, data })) as bigint;
      const gasPrice = (await publicClient.getGasPrice().catch(() => undefined)) as bigint | undefined;
      const balance = (await publicClient.getBalance({ address: deployer }).catch(() => undefined)) as bigint | undefined;
      return { gas, gasPrice, balance };
    },
    deploy: async (args) => {
      const txHash = (await wallet.deployContract({ abi, bytecode, args: [...args] })) as `0x${string}`;
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      if (receipt.status !== "success" || !receipt.contractAddress) {
        throw new Error(`[${networkName}] the deploy transaction ${txHash} did not create a contract (status ${receipt.status})`);
      }
      return { address: receipt.contractAddress as `0x${string}`, txHash };
    },
    reader: (address) => ({
      read: (fn, args) => publicClient.readContract({ address, abi: READ_ABI, functionName: fn, args: args ? [...args] : undefined }),
      getCode: () => publicClient.getCode({ address }),
    }),
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
