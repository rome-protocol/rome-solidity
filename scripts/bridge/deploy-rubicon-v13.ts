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
// arguments, the chain, the deploy key and the deploy key's nonce, so the real deploy sends
// exactly what was read, and the digest goes stale if the deploy key sends anything first):
//
//   export RUBICON_GAS_PRICE=$(( $(cast gas-price -r <rpc>) * 11 / 10 ))
//   npx tsx scripts/bridge/deploy-rubicon-v13.ts --network rubicon \
//       --owner <ledger> --guardian <ops key> --i-understand-mainnet
//   npx tsx scripts/bridge/deploy-rubicon-v13.ts --network rubicon \
//       --owner <ledger> --guardian <ops key> --i-understand-mainnet --deploy <digest>
//
// Every run compiles first (npx hardhat compile, done by the script), so the artifact always matches
// the working tree, and then checks the artifact's build-info against the files on disk.
// The dry run estimates gas at the pinned gas price and prints the deploy transaction, the
// constructor arguments, the source commit, the deploy key's nonce, the address the deploy will
// create and the digest. It sends nothing. On Rubicon the owner and guardian must be EIP-55
// checksummed accounts with no code, the owner must hold gas, contracts/, hardhat.config.ts and
// package-lock.json must be clean, the artifact must have been compiled from exactly those
// sources, the npm packages the compiler read must be the lockfile's own published packages (the
// script downloads each locked tarball, checks its sha512 against the lockfile and compares every
// compiler-input file with it: run it from a fresh clone after `npm ci`), RUBICON_GAS_PRICE must be
// set, and the owner must be the live v12 contract's owner() (and the guardian must not be), with a
// valid v12 address recorded and its owner readable, unless --owner-differs-from-v12 says it is on purpose. A real run
// deploys, reads back VERSION, owner, pendingOwner, guardian, the empty CCTP list, the unpaused
// rails, the USDC wrapper and mint, the empty Wormhole lists and the deploy key's lack of any
// role (with retries for RPC lag), checks that the transaction that was MINED is the approved
// deploy (success, a creation by the deploy key at the approved nonce, the predicted address, these
// bytes: a repriced replacement is recorded under its own hash; the send itself passes the approved
// nonce to the wallet), and fails loudly on any mismatch (and then writes nothing).
// It writes the address, the commit, the build, the code hash and the deploy input hash to
// deployments/rubicon.json under RomeBridgeWithdrawV13, next to the live v12 record, which it
// does not touch; the file is replaced atomically (a temp file renamed over it), so a failed write
// leaves v12 as it was. Then it PRINTS the two owner calls the Ledger signs (ensureBridgeAta(<Rubicon
// USDC mint>) first, then enableCctpDomain(0, 1)); it never sends them.
//
// If the deploy landed but the read-back or the file write failed, do not deploy again:
//   ... --i-understand-mainnet --verify-existing <address> --deploy-tx <hash> --source-commit <sha>
// checks that the transaction is the deploy key's creation of that address with exactly these
// bytes and that <sha> (the commit the deploy was run from) has the same sources as this
// checkout, reads it back, records it and prints the owner calls. It sends nothing. If the send
// itself answered with an error, the transaction MAY have landed: `cast nonce <deploy key>` and
// `cast code <predicted address>` (both printed before the send) say whether it did.
//
// This is the ONE script with an exception to lib/testnet-guard.ts: it may touch chain
// 7531, and only with --i-understand-mainnet, only when the process was started as this
// file (the guard reads argv[1] itself; nothing can hand it another entry point), and its send
// step calls the guard itself, with the digest it recomputed from the bytes and the nonce it is
// about to send. Every other script still refuses 7531. The same script runs on a testnet or a
// local Hardhat chain for rehearsal, with no flag.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs, { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import hardhat from "hardhat";
import { encodeDeployData } from "viem";
import { checkBuildProvenance, checkDependencySources, fetchTarballFromRegistry } from "./lib/build-provenance.js";
import {
  READ_ABI, RUBICON_NETWORK, USAGE, deployDigest, parseArgs, predictedAddress, runRubiconV13Deploy,
  type DeployDeps, type DeployOptions, type DeploymentStore,
} from "./lib/rubicon-v13.js";
import { assertRubiconV13DeploySend } from "./lib/testnet-guard.js";

/** This file's repo-relative path, as the guard compares it. A copy under another name is refused on mainnet. */
const SELF = path.relative(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), fileURLToPath(import.meta.url)).split(path.sep).join("/");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The paths whose contents decide the bytecode: the sources, the compiler settings and the dependency lock. */
const BUILD_PATHS = ["contracts/", "hardhat.config.ts", "package-lock.json"];

/** The file operations the store uses; tests pass a faulty one to prove a failed write leaves the file alone. */
export type FileIo = Pick<typeof fs, "existsSync" | "readFileSync" | "mkdirSync" | "openSync" | "writeSync" | "fsyncSync" | "closeSync" | "renameSync" | "unlinkSync" | "statSync" | "realpathSync">;

/**
 * A deployments file, read the way scripts/lib/deployments.ts does, and written ATOMICALLY: the new
 * text goes to a temp file in the same directory, is flushed, and is renamed over the destination, so a
 * full disk or a dying process leaves the old file whole (the v12 record included) and removes the
 * temp file. Writers are serialized by a lock file (`<file>.lock`, created exclusively, holding a token
 * only this run knows). A lock that already exists is NEVER taken over, not even one left by a dead
 * process: the run refuses and tells the operator to confirm that nothing else is running and to remove
 * the file by hand. A run releases only the lock it created (the token in the file is checked before
 * the unlink). `update` does the read, the change and the write under one lock, so two runs cannot
 * lose each other's change.
 */
export function fileStore(file: string, io: FileIo = fs): DeploymentStore {
  const read = (): Record<string, any> => (io.existsSync(file) ? JSON.parse(io.readFileSync(file, "utf8") as string) : {});

  function writeAtomic(data: Record<string, any>): void {
    // A symlinked file is replaced where it really lives.
    const target = io.existsSync(file) ? (io.realpathSync(file) as string) : file;
    const dir = path.dirname(target);
    io.mkdirSync(dir, { recursive: true });
    const mode = io.existsSync(target) ? io.statSync(target).mode & 0o777 : 0o644;
    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    const bytes = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8");
    let fd: number | undefined;
    try {
      fd = io.openSync(tmp, "wx", mode);
      for (let off = 0; off < bytes.length; ) off += io.writeSync(fd, bytes, off, bytes.length - off);
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      io.renameSync(tmp, target);
    } catch (e) {
      if (fd !== undefined) { try { io.closeSync(fd); } catch { /* the original error matters */ } }
      try { io.unlinkSync(tmp); } catch { /* it may not exist */ }
      throw e;
    }
    try {
      const dfd = io.openSync(dir, "r");
      try { io.fsyncSync(dfd); } finally { io.closeSync(dfd); }
    } catch {
      // flushing the directory entry is best effort (not every platform allows it); the rename already happened
    }
  }

  function locked<T>(fn: () => T): T {
    const target = io.existsSync(file) ? (io.realpathSync(file) as string) : file;
    const lock = `${target}.lock`;
    io.mkdirSync(path.dirname(lock), { recursive: true });
    const token = `${process.pid}:${randomUUID()}`;
    let fd: number;
    try {
      fd = io.openSync(lock, "wx", 0o644);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder = "";
      try { holder = String(io.readFileSync(lock, "utf8")).trim(); } catch { /* it may be gone already */ }
      throw new Error(
        `${path.basename(target)} is locked: ${lock} exists${holder ? ` (written by ${holder.split(":")[0]})` : ""}. This script never takes a lock over. ` +
        "Confirm that no other deploy run is active (ps, and the deploy key's transactions), then remove the lock file by hand and run again.",
      );
    }
    let wrote = false;
    try {
      io.writeSync(fd, token);
      wrote = true;
      return fn();
    } finally {
      try { io.closeSync(fd); } catch { /* released below */ }
      // Only the lock this run created: the file must still hold this run's token.
      let mine = !wrote; // a token that never got written: the file is the empty one this run just created
      if (wrote) {
        try { mine = String(io.readFileSync(lock, "utf8")) === token; } catch { /* gone: nothing to release */ }
      }
      if (mine) { try { io.unlinkSync(lock); } catch { /* already gone */ } }
    }
  }

  return {
    read,
    write: (data) => locked(() => writeAtomic(data)),
    update: (change) => locked(() => writeAtomic(change(read()))),
  };
}

/** The pinned gas price of a network config, when it has one (a number or a bigint, not "auto"). */
function pinnedGasPrice(config: any): bigint | undefined {
  const g = config?.gasPrice;
  return typeof g === "bigint" ? g : typeof g === "number" && Number.isFinite(g) ? BigInt(g) : undefined;
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
}

/** The error for a send that answered with an error: the transaction may still have landed. */
function sendFailed(networkName: string, deployer: string, nonce: number, predicted: string, cause: unknown): Error {
  return new Error(
    `[${networkName}] sending the deploy transaction failed (${(cause as Error)?.message?.split("\n")[0] ?? String(cause)}), but the transaction MAY have landed anyway. ` +
    `Do NOT deploy again and do not reuse the old digest. Deploy key ${deployer} used nonce ${nonce}: check \`cast nonce ${deployer}\` (nonce ${nonce + 1} means it landed) and ` +
    `\`cast code ${predicted}\` (code there means the contract exists). If it landed, find its transaction hash (the creation of ${predicted}) and run ` +
    "--verify-existing <address> --deploy-tx <hash> --source-commit <the commit you deployed from>. If it did not land, run the dry run again.",
  );
}

/**
 * Wires runRubiconV13Deploy to a Hardhat network connection. Nothing is sent until the flow
 * asks, and the one send (`deploy`) asks the guard itself, with the operator's flag and the result
 * of recomputing the digest from the bytes and nonce it is about to send, so it is never reachable
 * unguarded and never with a stale approval. Only this file and its test import this module (a test
 * scans for any other importer), and the guard also requires that the process was started as this
 * file.
 */
export async function depsFromConnection(
  connection: { viem: any; networkName: string; networkConfig?: any },
  store: DeploymentStore,
  log: (line: string) => void = console.log,
  options: { fetchTarball?: (url: string) => Promise<Buffer> } = {},
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
  const label = `${networkName} deploy RomeBridgeWithdraw 13.0.0`;
  // The guard reads the chain id the RPC reports, never the network's name.
  const guard = (mainnetFlag: boolean) =>
    assertRubiconV13DeploySend(publicClient, label, { script: SELF, mainnetFlag, phase: "inspect", digestMatches: false });
  const deployData = (args: readonly unknown[]) => encodeDeployData({ abi, bytecode, args: [...args] as any });
  const pendingNonce = async (): Promise<number> => Number(await publicClient.getTransactionCount({ address: deployer, blockTag: "pending" }));

  return {
    networkName,
    deployer,
    guard,
    store,
    deployData: (args) => deployData(args),
    nonce: pendingNonce,
    estimate: async (args) => {
      const gas = (await publicClient.estimateGas({ account: deployer, data: deployData(args) })) as bigint;
      // The real deploy uses the network's pinned price; only without one is the RPC's price shown.
      const gasPrice = pinned ?? ((await publicClient.getGasPrice().catch(() => undefined)) as bigint | undefined);
      const balance = (await publicClient.getBalance({ address: deployer }).catch(() => undefined)) as bigint | undefined;
      return { gas, gasPrice, gasPricePinned: pinned !== undefined, balance };
    },
    deploy: async (args, mainnetFlag, digest) => {
      // The final send boundary. Chain, bytes and nonce are read HERE, and the guard only lets chain 7531
      // through when the operator's digest equals the digest of exactly these.
      const data = deployData(args);
      const nonce = await pendingNonce();
      const chainId = Number(await publicClient.getChainId());
      const digestMatches = digest !== undefined && digest.toLowerCase() === deployDigest(data, chainId, deployer, nonce).toLowerCase();
      await assertRubiconV13DeploySend(publicClient, label, { script: SELF, mainnetFlag, phase: "send", digestMatches });
      const predicted = predictedAddress(deployer, nonce);
      let txHash: `0x${string}`;
      try {
        txHash = (await wallet.deployContract({ abi, bytecode, args: [...args], nonce })) as `0x${string}`;
      } catch (e) {
        throw sendFailed(networkName, deployer, nonce, predicted, e);
      }
      let receipt: any;
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      } catch (e) {
        throw new Error(
          `[${networkName}] the deploy transaction ${txHash} was sent, but its receipt could not be read (${(e as Error).message.split("\n")[0]}). ` +
          `Do NOT deploy again: check the transaction (and \`cast code ${predicted}\`), then re-run with --verify-existing <the address it created> --deploy-tx ${txHash} --source-commit <the commit you deployed from>`,
        );
      }
      if (receipt.status !== "success" || !receipt.contractAddress) {
        throw new Error(`[${networkName}] the deploy transaction ${txHash} did not create a contract (status ${receipt.status})`);
      }
      // A transaction repriced with the same nonce is mined under ANOTHER hash: the receipt's is the one that counts.
      const minedHash = (receipt.transactionHash ?? txHash) as `0x${string}`;
      if (minedHash.toLowerCase() !== txHash.toLowerCase()) log(`[${networkName}] the sent transaction ${txHash} was replaced; the mined one is ${minedHash}`);
      return { address: receipt.contractAddress as `0x${string}`, txHash: minedHash };
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
        contractsClean = git(["status", "--porcelain", "--", ...BUILD_PATHS]) === "";
      } catch {
        // not a git checkout: unknown commit, and a mainnet run refuses (contractsClean stays false)
      }
      // The artifact must have been compiled from the files that are on disk now.
      const cfg: any = hardhat.config;
      const profiles = cfg.solidity?.profiles ?? {};
      const profile = profiles[(hardhat.globalOptions as any)?.buildProfile ?? "default"] ?? profiles.default;
      const compiler = profile?.compilers?.[0];
      const build = !compiler || !(artifact as any).buildInfoId
        ? { ok: false, problems: ["the build profile or the artifact's build-info id could not be read"], buildInfoId: String((artifact as any).buildInfoId ?? "unknown"), solcVersion: undefined as string | undefined }
        : checkBuildProvenance({
            root: cfg.paths?.root ?? REPO,
            artifactsDir: cfg.paths?.artifacts ?? path.join(REPO, "artifacts"),
            buildInfoId: (artifact as any).buildInfoId,
            inputSourceName: (artifact as any).inputSourceName,
            contractName: artifact.contractName,
            artifactBytecode: bytecode,
            expectedSolcVersion: compiler.version,
            expectedSettings: compiler.settings ?? {},
          });
      // On Rubicon the dependencies the compiler read must also be the locked packages' own files (a
      // patched node_modules with an unchanged lockfile is refused). It needs the npm registry, so
      // rehearsals on other networks skip it.
      if (networkName === RUBICON_NETWORK && compiler && (artifact as any).buildInfoId) {
        const depProblems = await checkDependencySources({
          root: cfg.paths?.root ?? REPO,
          artifactsDir: cfg.paths?.artifacts ?? path.join(REPO, "artifacts"),
          buildInfoId: (artifact as any).buildInfoId,
          fetchTarball: options.fetchTarball ?? fetchTarballFromRegistry,
        });
        if (depProblems.length > 0) return { commit, contractsClean, build: { ...build, ok: false, problems: [...build.problems, ...depProblems] } };
      }
      return { commit, contractsClean, build };
    },
    sourceAt: async (commit) => {
      try {
        const full = git(["rev-parse", "--verify", `${commit}^{commit}`]);
        try {
          execFileSync("git", ["diff", "--quiet", full, "HEAD", "--", ...BUILD_PATHS], { cwd: REPO });
        } catch {
          return { commit: full, sameSources: false, problem: `${commit} has different contracts/, hardhat.config.ts or package-lock.json from this checkout's HEAD` };
        }
        return { commit: full, sameSources: true };
      } catch {
        return { commit, sameSources: false, problem: `${commit} is not a commit in this checkout (git fetch it, or check out the commit the deploy was run from)` };
      }
    },
    getDeployTx: async (hash) => {
      const tx = await publicClient.getTransaction({ hash }).catch(() => undefined);
      if (!tx) return undefined;
      const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => undefined);
      let blockTimestamp: number | undefined;
      if (receipt?.blockHash) {
        // The block the receipt names, by hash (not whatever is at that height now).
        const block = await publicClient.getBlock({ blockHash: receipt.blockHash }).catch(() => undefined);
        if (block) blockTimestamp = Number(block.timestamp);
      }
      return { from: tx.from, input: tx.input, to: tx.to, nonce: tx.nonce === undefined ? undefined : Number(tx.nonce), status: receipt?.status ?? "pending", contractAddress: receipt?.contractAddress, blockTimestamp };
    },
    simulate: async (from, call) => {
      await publicClient.call({ account: from, to: call.to, data: call.data });
    },
    log,
  };
}

/** The compile step's watchdog: a viaIR compile can hang, so a run that waits longer than this stops. */
const COMPILE_WATCHDOG_MS = 10 * 60 * 1000;

/** Compiles the project, so the artifact is built from the working tree whatever was compiled before. */
export async function compileProject(watchdogMs: number = COMPILE_WATCHDOG_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the compile took longer than ${Math.round(watchdogMs / 60000)} minutes: stopping (nothing was sent)`)), watchdogMs);
  });
  try {
    await Promise.race([hardhat.tasks.getTask("compile").run({}), watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main() {
  // Arguments first: a missing owner or guardian, or Rubicon without the flag, stops here,
  // before any network connection exists.
  const opts: DeployOptions = parseArgs(process.argv.slice(2));
  // Then a fresh compile, so the artifact is the working tree's (the build-info check refuses otherwise).
  await compileProject();
  const connection = await hardhat.network.connect(opts.network);
  const store = fileStore(path.resolve(process.cwd(), "deployments", `${connection.networkName}.json`));
  const deps = await depsFromConnection(connection, store);
  await runRubiconV13Deploy(deps, opts);
}

/**
 * True when argv1 is this file, compared by real path (a symlinked start is still this file),
 * the same rule lib/testnet-guard.ts uses for the entry point.
 */
export function isEntryPoint(argv1: string | undefined, selfUrl: string = import.meta.url): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(path.resolve(argv1)) === realpathSync(fileURLToPath(selfUrl));
  } catch {
    return false;
  }
}

// Run only when this file is the entry point, so the tests can import the functions above.
if (isEntryPoint(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    console.error(USAGE);
    process.exit(1);
  });
}
