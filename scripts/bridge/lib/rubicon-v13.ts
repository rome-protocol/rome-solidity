// scripts/bridge/lib/rubicon-v13.ts
//
// The logic behind scripts/bridge/deploy-rubicon-v13.ts, with every outside
// dependency (the chain, the deployments file, the clock) passed in, so the
// tests run it on a local Hardhat chain and never need a live network.
//
// What the deploy does, in order:
//   1. asks the guard whether this chain may be touched (chain 7531 only with
//      --i-understand-mainnet, and only when this process was started as
//      scripts/bridge/deploy-rubicon-v13.ts; lib/testnet-guard.ts)
//   2. checks the roles: owner = the cold Ledger, guardian = the ops key, both
//      given explicitly, neither zero, neither the deploy key, not each other. On
//      Rubicon both must be EIP-55 checksummed, hold no code, and the owner must hold gas.
//   3. builds the constructor arguments (lib/withdraw-ctor-args.ts, the same ones
//      deploy.ts uses on the testnets)
//   4. a DRY RUN estimates gas, prints the deploy transaction, the constructor arguments, the
//      source commit, the hash of the deploy transaction's input and a DEPLOY DIGEST, and stops. Nothing is sent. On
//      Rubicon a dry run is the default; the real deploy needs --deploy <digest>, the digest
//      of the exact bytes (and chain and deploy key) the dry run showed.
//   5. deploys with the hot deploy key, reads everything back (with retries for RPC lag), and
//      fails loudly on any mismatch (and then writes nothing)
//   6. records the address under RomeBridgeWithdrawV13 in deployments/<network>.json,
//      next to the live v12 record and without touching it
//   7. PRINTS the owner calls the Ledger signs. It never sends them.
// --verify-existing <address> --deploy-tx <hash> --source-commit <sha> does steps 5 to 7 for a
// contract that is already deployed (a read-back that failed on a transient error), without
// sending anything.

import { concatHex, encodeFunctionData, getAddress, getContractAddress, isAddress, keccak256, pad, parseAbi, toHex, type Hex } from "viem";
import { base58ToBytes32 } from "../../lib/pubkey.js";
import { MAINNET_FLAG } from "./testnet-guard.js";
import { ZERO_ADDRESS, buildWithdrawConstructorArgs } from "./withdraw-ctor-args.js";

export const EXPECTED_VERSION = "13.0.0";
/** The key the new address is written under. The live v12 record (RomeBridgeWithdraw) is never touched. */
export const RECORD_KEY = "RomeBridgeWithdrawV13";
export const RUBICON_NETWORK = "rubicon";
export const RUBICON_CHAIN_ID = 7531;
/** Circle's CCTP domain of Ethereum, and RECIPIENT_EVM in the contract. */
export const ETHEREUM_DOMAIN = 0;
export const RECIPIENT_EVM = 1;

type Address = `0x${string}`;
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ── Arguments ──────────────────────────────────────────────────────────────

export interface DeployOptions {
  network: string;
  owner: string;
  guardian: string;
  dryRun: boolean;
  mainnetFlag: boolean;
  /** --deploy <digest>: the digest a dry run printed. Required for a real deploy on Rubicon. */
  deployDigest: string | undefined;
  /**
   * --verify-existing <address> --deploy-tx <hash> --source-commit <sha>: check and record a contract
   * that is already deployed. The commit is the one the deploy was run from; the recovery never
   * substitutes its own checkout's HEAD for it.
   */
  verifyExisting: { address: string; txHash: string; sourceCommit: string } | undefined;
  /**
   * --owner-differs-from-v12: on Rubicon the owner must be the live v12 contract's owner() (the
   * chain's contract admin) unless the operator says on purpose that it is not.
   */
  ownerDiffersFromV12: boolean;
}

export const OWNER_DIFFERS_FLAG = "--owner-differs-from-v12";

export const USAGE =
  "usage: npx tsx scripts/bridge/deploy-rubicon-v13.ts --network <name> --owner <ledger address> --guardian <ops key address> " +
  `[--dry-run | --deploy <digest> | --verify-existing <address> --deploy-tx <hash> --source-commit <sha>] [${OWNER_DIFFERS_FLAG}] [${MAINNET_FLAG}]`;

const VALUE_OPTIONS = ["--network", "--owner", "--guardian", "--deploy", "--verify-existing", "--deploy-tx", "--source-commit"];
const COMMIT_RE = /^[0-9a-fA-F]{40}$/;
const DIGEST_RE = /^0x[0-9a-fA-F]{16}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Parses the command line (after the script name). Unknown arguments, a missing
 * value, a repeated option, a missing --owner / --guardian / --network and a
 * Rubicon run without --i-understand-mainnet are all refused. Nothing has a default.
 */
export function parseArgs(argv: readonly string[]): DeployOptions {
  const seen = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let name: string;
    let value: string | true;
    if (a === "--dry-run" || a === MAINNET_FLAG || a === OWNER_DIFFERS_FLAG) {
      name = a;
      value = true;
    } else if (VALUE_OPTIONS.includes(a)) {
      name = a;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${a} needs a value. ${USAGE}`);
      value = next;
      i++;
    } else if (new RegExp(`^(${VALUE_OPTIONS.join("|")})=`).test(a)) {
      const eqAt = a.indexOf("=");
      name = a.slice(0, eqAt);
      value = a.slice(eqAt + 1);
      if (value === "") throw new Error(`${name} needs a value. ${USAGE}`);
    } else {
      throw new Error(`unknown argument "${a}". ${USAGE}`);
    }
    if (seen.has(name)) throw new Error(`${name} given twice. ${USAGE}`);
    seen.set(name, value);
  }
  const need = (n: string): string => {
    const v = seen.get(n);
    if (typeof v !== "string") throw new Error(`${n} is required and has no default. ${USAGE}`);
    return v;
  };
  const opt = (n: string): string | undefined => {
    const v = seen.get(n);
    return typeof v === "string" ? v : undefined;
  };
  const deployDigest = opt("--deploy");
  const vAddr = opt("--verify-existing");
  const vTx = opt("--deploy-tx");
  const vCommit = opt("--source-commit");
  const opts: DeployOptions = {
    network: need("--network"),
    owner: need("--owner"),
    guardian: need("--guardian"),
    dryRun: seen.has("--dry-run"),
    mainnetFlag: seen.has(MAINNET_FLAG),
    deployDigest,
    verifyExisting: vAddr !== undefined && vTx !== undefined && vCommit !== undefined ? { address: vAddr, txHash: vTx, sourceCommit: vCommit } : undefined,
    ownerDiffersFromV12: seen.has(OWNER_DIFFERS_FLAG),
  };
  if (deployDigest !== undefined && !DIGEST_RE.test(deployDigest)) throw new Error(`--deploy needs the 8-byte digest a dry run prints (0x and 16 hex digits). ${USAGE}`);
  if (new Set([vAddr === undefined, vTx === undefined, vCommit === undefined]).size > 1) throw new Error(`--verify-existing, --deploy-tx and --source-commit go together. ${USAGE}`);
  if (vCommit !== undefined && !COMMIT_RE.test(vCommit)) throw new Error(`--source-commit "${vCommit}" is not a full 40-digit git commit hash. ${USAGE}`);
  if (vAddr !== undefined && !isAddress(vAddr)) throw new Error(`--verify-existing "${vAddr}" is not a 20-byte address. ${USAGE}`);
  if (vTx !== undefined && !TX_RE.test(vTx)) throw new Error(`--deploy-tx "${vTx}" is not a transaction hash. ${USAGE}`);
  const modes = [opts.dryRun, deployDigest !== undefined, vAddr !== undefined].filter(Boolean).length;
  if (modes > 1) throw new Error(`--dry-run, --deploy and --verify-existing are different modes: give one. ${USAGE}`);
  if (opts.network === RUBICON_NETWORK && !opts.mainnetFlag) {
    throw new Error(`--network ${RUBICON_NETWORK} is mainnet: pass ${MAINNET_FLAG} (a run without --deploy is a dry run). ${USAGE}`);
  }
  return opts;
}

// ── Roles ──────────────────────────────────────────────────────────────────

export interface Roles {
  owner: Address;
  guardian: Address;
  deployer: Address;
}

function parseAddress(label: string, v: string, strict = false): Address {
  if (!isAddress(v)) throw new Error(`${label} "${v}" is not a 20-byte address (mixed-case addresses must have a valid checksum)`);
  // viem accepts an all-lowercase address with no checksum, so a one-character typo would pass.
  // On mainnet the input must carry the EIP-55 checksum, which catches it.
  if (strict && v !== getAddress(v)) throw new Error(`${label} "${v}" is not EIP-55 checksummed: on Rubicon copy it with its checksum (it should read ${getAddress(v)} if it is the address you meant)`);
  return getAddress(v);
}

/**
 * owner = the cold Ledger, guardian = the ops key, deployer = the hot deploy key.
 * All three are different, and none is zero. The deploy key ends the deploy with no role.
 */
export function validateRoles(i: { deployer: string; owner: string; guardian: string }, strictChecksum = false): Roles {
  const owner = parseAddress("--owner", i.owner, strictChecksum);
  const guardian = parseAddress("--guardian", i.guardian, strictChecksum);
  const deployer = parseAddress("the deploy key's address", i.deployer);
  if (eq(owner, ZERO_ADDRESS)) throw new Error("--owner is the zero address: the contract would have no admin");
  if (eq(guardian, ZERO_ADDRESS)) throw new Error("--guardian is the zero address: Rubicon needs the ops key as the stop-only guardian");
  if (eq(owner, guardian)) throw new Error(`--owner and --guardian are the same address (${owner}): the guardian is the stop-only ops key and must differ from the cold owner`);
  if (eq(owner, deployer)) throw new Error(`--owner is the deploy key (${deployer}): the owner must be the cold Ledger, not the hot key that sends the deploy`);
  if (eq(guardian, deployer)) throw new Error(`--guardian is the deploy key (${deployer}): the deploy key must end with no role`);
  return { owner, guardian, deployer };
}

// ── The owner calls the Ledger signs ───────────────────────────────────────

const OWNER_ABI = parseAbi([
  "function enableCctpDomain(uint32 domain, uint8 recipientKind)",
  "function ensureBridgeAta(bytes32 mint)",
]);

export interface OwnerCall {
  /** What the Ledger user reads before signing. */
  description: string;
  to: Address;
  data: Hex;
  /** Always 0: none of these calls carries value. */
  value: "0";
}

/**
 * The two calls the cold Ledger signs after the deploy. Printed, never sent. The token account
 * comes first: enabling the CCTP domain first would leave the rail open on a bridge with no
 * USDC token account, where every burn would revert.
 */
export function buildOwnerCalls(bridge: Address, usdcMintBase58: string): OwnerCall[] {
  const mint = base58ToBytes32(usdcMintBase58);
  return [
    {
      description: `ensureBridgeAta(${mint}): create the bridge's USDC token account (mint ${usdcMintBase58}); paid from the operator's rent, so it is owner-only. Sign this FIRST: no domain is enabled yet, so no burn can reach a bridge without the account.`,
      to: bridge,
      data: encodeFunctionData({ abi: OWNER_ABI, functionName: "ensureBridgeAta", args: [mint] }),
      value: "0",
    },
    {
      description: `enableCctpDomain(${ETHEREUM_DOMAIN}, ${RECIPIENT_EVM}): enable Ethereum (CCTP domain 0) as an EVM-recipient destination. Sign this SECOND: it opens the CCTP rail. The contract derives and checks Circle's RemoteTokenMessenger account itself.`,
      to: bridge,
      data: encodeFunctionData({ abi: OWNER_ABI, functionName: "enableCctpDomain", args: [ETHEREUM_DOMAIN, RECIPIENT_EVM] }),
      value: "0",
    },
  ];
}

// ── Read-back ──────────────────────────────────────────────────────────────

const READ_ABI = parseAbi([
  "function VERSION() view returns (string)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function guardian() view returns (address)",
  "function cctpDomains() view returns (uint32[])",
  "function railPaused(uint8 rail) view returns (bool)",
  "function usdcWrapper() view returns (address)",
  "function usdcMint() view returns (bytes32)",
  "function wormholeTargetChainAllowed(uint16 chain) view returns (bool)",
  "function wormholeMintAllowed(bytes32 mint) view returns (bool)",
]);
export { READ_ABI };

/** One read of the deployed contract, plus its code. The script wires this to the chain; tests wire it to a local one. */
export interface ChainReader {
  read(fn: string, args?: readonly unknown[]): Promise<unknown>;
  getCode(): Promise<string | undefined>;
}

export interface Expected {
  owner: Address;
  guardian: Address;
  deployer: Address;
  usdcWrapper: Address;
  usdcMintBase58: string;
}

/** Wormhole destination chains that must be off at deploy: Ethereum (2) and Sepolia (10002). */
const WORMHOLE_CHAINS_TO_CHECK = [2, 10002];
const RAILS = [["CCTP", 0], ["WORMHOLE", 1], ["TO_SOLANA", 2]] as const;

/**
 * Reads the deployed contract and compares it with what was asked for. Collects every
 * mismatch and throws one error listing them all; resolves with the lines it checked.
 */
export async function verifyDeployment(r: ChainReader, want: Expected): Promise<string[]> {
  const bad: string[] = [];
  const ok: string[] = [];
  const check = (label: string, got: unknown, wanted: unknown, same: (a: unknown, b: unknown) => boolean = (a, b) => a === b) => {
    if (same(got, wanted)) ok.push(`${label} = ${String(got)}`);
    else bad.push(`${label} is ${String(got)}, expected ${String(wanted)}`);
  };
  const addrEq = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && eq(a, b);

  const code = await r.getCode();
  if (!code || code === "0x") throw new Error("read-back failed (1):\n  - no contract code at the deployed address");

  check("VERSION()", await r.read("VERSION"), EXPECTED_VERSION);
  check("owner()", await r.read("owner"), want.owner, addrEq);
  check("pendingOwner()", await r.read("pendingOwner"), ZERO_ADDRESS, addrEq);
  check("guardian()", await r.read("guardian"), want.guardian, addrEq);
  const domains = ((await r.read("cctpDomains")) as readonly (number | bigint)[]).map(Number);
  check("cctpDomains()", `[${domains.join(",")}]`, "[]");
  for (const [name, rail] of RAILS) check(`railPaused(${name})`, await r.read("railPaused", [rail]), false);
  check("usdcWrapper()", await r.read("usdcWrapper"), want.usdcWrapper, addrEq);
  check("usdcMint()", await r.read("usdcMint"), base58ToBytes32(want.usdcMintBase58), addrEq);
  for (const c of WORMHOLE_CHAINS_TO_CHECK) check(`wormholeTargetChainAllowed(${c})`, await r.read("wormholeTargetChainAllowed", [c]), false);
  check("wormholeMintAllowed(USDC)", await r.read("wormholeMintAllowed", [base58ToBytes32(want.usdcMintBase58)]), false);

  // The deploy key has no role: it is not the owner, the pending owner or the guardian.
  const owner = (await r.read("owner")) as string;
  const pending = (await r.read("pendingOwner")) as string;
  const guardian = (await r.read("guardian")) as string;
  for (const [role, who] of [["owner", owner], ["pendingOwner", pending], ["guardian", guardian]] as const) {
    if (eq(who, want.deployer)) bad.push(`the deploy key ${want.deployer} holds the ${role} role`);
    else ok.push(`deploy key is not the ${role}`);
  }

  if (bad.length > 0) throw new Error(`read-back failed (${bad.length}):\n  - ${bad.join("\n  - ")}`);
  return ok;
}

// ── The deployments record ─────────────────────────────────────────────────

export interface DeploymentStore {
  read(): Record<string, any>;
  write(data: Record<string, any>): void;
  /**
   * Read, change and write back as one step that other writers cannot interleave with. The record
   * is written through this when the store has it (the file store does: a lock, then a temp file
   * renamed over the destination), so a failed or concurrent write never costs the v12 record.
   */
  update?(change: (current: Record<string, any>) => Record<string, any>): void;
}

export interface V13Record {
  address: Address;
  version: string;
  owner: Address;
  guardian: Address;
  deployTx: Hex;
  deployedAt: number;
  /**
   * The commit the bytecode was built from. A fresh deploy records `git rev-parse HEAD` of a checkout whose
   * contracts/, hardhat.config.ts and package-lock.json are clean and whose artifact was checked against them;
   * a recovery records the --source-commit the operator gave, after checking its sources equal the checkout's.
   */
  commit: string;
  /** The build the bytes came from: the compiler input's id and the solc version. */
  build: { buildInfoId: string; solcVersion: string };
  /**
   * keccak256 of eth_getCode(address), taken after the read-back. Check it against the chain with
   * `cast keccak $(cast code <address> -r <rpc>)`. (The local artifact's runtime bytecode cannot be
   * compared: the constructor writes the immutables into the deployed code.)
   */
  codeHash: Hex;
  /** keccak256 of the deploy transaction's input (creation bytecode and constructor arguments). Check with `cast keccak $(cast tx <deployTx> input -r <rpc>)`. */
  deployInputHash: Hex;
}

/** Adds the V13 record next to everything else. Refuses to replace an existing V13 record. */
export function withV13Record(existing: Record<string, any>, rec: V13Record): Record<string, any> {
  if (existing[RECORD_KEY]) throw new Error(`${RECORD_KEY} is already recorded (${existing[RECORD_KEY].address}): refusing to overwrite it`);
  return { ...existing, [RECORD_KEY]: rec };
}

/** The USDC wrapper and mint the new bridge is built on, from the network's deployments record. */
export function usdcFromDeployments(d: Record<string, any>, network: string): { wrapper: Address; mintBase58: string } {
  const u = d["SPL_ERC20_USDC"];
  const wrapper = u?.address;
  const mint = u?.mintId;
  if (typeof wrapper !== "string" || !isAddress(wrapper) || typeof mint !== "string") {
    throw new Error(`deployments/${network}.json has no SPL_ERC20_USDC with an address and a mintId: the USDC wrapper must be recorded first`);
  }
  base58ToBytes32(mint); // throws if it is not a 32-byte base58 key
  return { wrapper: getAddress(wrapper), mintBase58: mint };
}

// ── The deploy itself ──────────────────────────────────────────────────────

type CtorArgs = ReturnType<typeof buildWithdrawConstructorArgs>;

export interface DeployDeps {
  networkName: string;
  /** The hot deploy key's address (the key itself never leaves the wallet client). */
  deployer: string;
  /**
   * Asks the guard about the chain the RPC reports; resolves with its id or throws. The
   * guard decides from the chain id, the script's own path and the process entry point.
   */
  guard(mainnetFlag: boolean): Promise<number>;
  store: DeploymentStore;
  /** The creation bytecode plus the encoded constructor arguments: exactly what the deploy transaction carries. */
  deployData(args: CtorArgs): Hex;
  /**
   * Gas for the deploy transaction, from the node. A dry run sends nothing. `gasPrice` is the
   * price the real deploy will use: the network's pinned gasPrice when it has one (then
   * `gasPricePinned` is true), the RPC's otherwise.
   */
  estimate(args: CtorArgs): Promise<{ gas: bigint; gasPrice?: bigint; gasPricePinned: boolean; balance?: bigint }>;
  /** The deploy key's transaction count including pending ones: the nonce its next transaction takes. */
  nonce(): Promise<number>;
  /**
   * Sends the deploy transaction and waits for it to be mined. Calls the guard itself, with the
   * operator's flag, and on Rubicon only when `digest` equals the digest recomputed from the bytes and
   * the nonce about to be sent. Resolves with the address and the hash of the transaction that was
   * MINED (the receipt's hash, which is not the sent hash when the transaction was replaced).
   */
  deploy(args: CtorArgs, mainnetFlag: boolean, digest?: Hex): Promise<{ address: Address; txHash: Hex }>;
  reader(address: Address): ChainReader;
  /** Code and balance of an account. */
  accountInfo(address: Address): Promise<{ hasCode: boolean; balance: bigint }>;
  /**
   * The checkout the artifact was built from: git commit, whether contracts/, hardhat.config.ts and
   * package-lock.json are clean, and whether the artifact was compiled from exactly the sources and
   * settings on disk (the build-info check, lib/build-provenance.ts).
   */
  source(): Promise<{ commit: string; contractsClean: boolean; build: { ok: boolean; problems: string[]; buildInfoId: string; solcVersion?: string } }>;
  /** For a recovery: whether the operator's --source-commit has the same contracts, config and lockfile as this checkout. Resolves with the full hash. */
  sourceAt(commit: string): Promise<{ commit: string; sameSources: boolean; problem?: string }>;
  /**
   * A mined transaction: for --verify-existing, and after a deploy for its input and its block's
   * timestamp (seconds). Undefined when the node does not know it. The block is the one the
   * receipt names (by hash).
   */
  getDeployTx(hash: Hex): Promise<{ from: string; input: Hex; to: string | null | undefined; nonce?: number; status: string; contractAddress: string | null | undefined; blockTimestamp?: number } | undefined>;
  /** eth_call of an owner call from the owner's address; the answer is printed, never fatal. */
  simulate?(from: Address, call: OwnerCall): Promise<void>;
  log(line: string): void;
  /** Pause between read-back retries. Defaults to a real timer. */
  sleep?(ms: number): Promise<void>;
}

export interface DeployResult {
  dryRun: boolean;
  chainId: number;
  roles: Roles;
  args: CtorArgs;
  /** The digest of this deploy (not for --verify-existing). */
  digest?: Hex;
  nonce?: number;
  deployed?: { address: Address; txHash: Hex };
  ownerCalls?: OwnerCall[];
}

function jsonArgs(args: unknown): string {
  return JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

/**
 * The 8-byte digest that ties a real deploy to a dry run: keccak256 of the deploy transaction's
 * data (bytecode and constructor arguments, so owner and guardian), the chain id, the deploy
 * key's address and the deploy key's nonce. A changed artifact, owner, guardian, chain, deploy key
 * or nonce changes it. The nonce is in it so that a deploy that landed (whatever the script saw of
 * the answer) makes the old digest stale: the address a deploy creates is set by the nonce.
 */
export function deployDigest(data: Hex, chainId: number, deployer: string, nonce: number | bigint): Hex {
  const h = keccak256(concatHex([data, pad(toHex(chainId), { size: 32 }), getAddress(deployer), pad(toHex(BigInt(nonce)), { size: 32 })]));
  return h.slice(0, 18) as Hex;
}

/** The address a contract creation from `deployer` at `nonce` gets. */
export function predictedAddress(deployer: string, nonce: number | bigint): Address {
  return getContractAddress({ from: getAddress(deployer), nonce: BigInt(nonce) });
}

/** What a mined deploy transaction must be for the record: success, a creation, by the deploy key, of this address, with these bytes (and, for a fresh deploy, the approved nonce). */
export function deployTxProblems(tx: { from: string; input: Hex; to: string | null | undefined; status: string; contractAddress: string | null | undefined; nonce?: number }, address: string, data: Hex, deployer: string, approvedNonce?: number): string[] {
  const problems: string[] = [];
  if (tx.status !== "success") problems.push(`the transaction status is ${tx.status}`);
  if (tx.to) problems.push(`the transaction is a call to ${tx.to}, not a contract creation`);
  if (!eq(tx.from, deployer)) problems.push(`the transaction was sent by ${tx.from}, not by the deploy key ${deployer}`);
  if (!tx.contractAddress || !eq(tx.contractAddress, address)) problems.push(`the transaction created ${tx.contractAddress ?? "no contract"}, not ${address}`);
  if (tx.input.toLowerCase() !== data.toLowerCase()) problems.push("the transaction data is not this artifact's bytecode with these constructor arguments");
  // A fresh deploy knows the nonce it approved; a recovery (--verify-existing) does not, and skips this.
  if (approvedNonce !== undefined && tx.nonce !== approvedNonce) problems.push(`the transaction used nonce ${tx.nonce ?? "(unknown)"}, not the approved nonce ${approvedNonce}`);
  return problems;
}

const READBACK_ATTEMPTS = 4;
const READBACK_PAUSE_MS = 2000;

/** The recovery command a failure message points at (the deploy landed; do not send it again). */
function recoverArgs(address: string, txHash: string, commit: string): string {
  return `--verify-existing ${address} --deploy-tx ${txHash} --source-commit ${commit}`;
}

const sleeper = (deps: DeployDeps) => deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

/** The read-back, retried when the node lags (no code yet, a failed call). A value that is wrong is final at once. */
async function verifyWithRetry(deps: DeployDeps, address: Address, txHash: Hex, want: Expected, recover: string): Promise<string[]> {
  const tag = `[${deps.networkName}]`;
  const sleep = sleeper(deps);
  let last = "";
  for (let i = 1; i <= READBACK_ATTEMPTS; i++) {
    try {
      return await verifyDeployment(deps.reader(address), want);
    } catch (e) {
      last = (e as Error).message;
      const wrong = last.startsWith("read-back failed") && !/no contract code/.test(last);
      if (wrong) {
        throw new Error(
          `${tag} the contract at ${address} (tx ${txHash}) FAILED the read-back and was NOT recorded. ` +
          `Do not use it; do not enable anything on it.\n${last}`,
        );
      }
      if (i < READBACK_ATTEMPTS) await sleep(READBACK_PAUSE_MS * i);
    }
  }
  throw new Error(
    `${tag} the deploy transaction ${txHash} created ${address}, but the read-back could not be completed after ${READBACK_ATTEMPTS} tries ` +
    `(${last.split("\n").slice(0, 3).join(" ").trim()}). Nothing was recorded. Do NOT deploy again. ` +
    `Re-run the same command with ${recover} (instead of --deploy) to read it back and record it.`,
  );
}

type MinedTx = NonNullable<Awaited<ReturnType<DeployDeps["getDeployTx"]>>>;

/**
 * The mined deploy transaction with its block's time, retried while the node lags. Both are needed
 * for the record, so without them nothing is recorded: the record never takes the local clock.
 */
async function fetchMinedDeploy(deps: DeployDeps, hash: Hex, hint: string): Promise<MinedTx & { blockTimestamp: number }> {
  const tag = `[${deps.networkName}]`;
  const sleep = sleeper(deps);
  let seen: MinedTx | undefined;
  for (let i = 1; i <= READBACK_ATTEMPTS; i++) {
    const tx = await deps.getDeployTx(hash).catch(() => undefined);
    if (tx) seen = tx;
    if (tx && tx.status !== "pending" && tx.blockTimestamp !== undefined) return tx as MinedTx & { blockTimestamp: number };
    if (i < READBACK_ATTEMPTS) await sleep(READBACK_PAUSE_MS * i);
  }
  if (!seen) throw new Error(`${tag} the node does not know transaction ${hash}. Nothing was recorded. ${hint}`);
  if (seen.status === "pending") throw new Error(`${tag} transaction ${hash} is not mined yet. Nothing was recorded. ${hint}`);
  throw new Error(`${tag} the block time of ${hash} could not be read, so deployedAt cannot be recorded. Nothing was recorded. ${hint}`);
}

export async function runRubiconV13Deploy(deps: DeployDeps, opts: DeployOptions): Promise<DeployResult> {
  const { log } = deps;
  const tag = `[${deps.networkName}]`;

  // 1. The guard, before anything else touches the chain.
  const chainId = await deps.guard(opts.mainnetFlag);
  if (deps.networkName === RUBICON_NETWORK && chainId !== RUBICON_CHAIN_ID) {
    throw new Error(`${tag} the RPC reports chain ${chainId}, not ${RUBICON_CHAIN_ID}: refusing, the deployments file would be wrong`);
  }
  if (chainId === RUBICON_CHAIN_ID && deps.networkName !== RUBICON_NETWORK) {
    throw new Error(`${tag} the RPC reports Rubicon (${RUBICON_CHAIN_ID}) but the network is called "${deps.networkName}": use --network ${RUBICON_NETWORK}`);
  }
  const mainnet = chainId === RUBICON_CHAIN_ID;
  const verifying = opts.verifyExisting !== undefined;

  // 2. Roles. On Rubicon: checksummed, no code, and the owner holds gas.
  const roles = validateRoles({ deployer: deps.deployer, owner: opts.owner, guardian: opts.guardian }, mainnet);
  const ownerInfo = await deps.accountInfo(roles.owner);
  const guardianInfo = await deps.accountInfo(roles.guardian);
  if (mainnet) {
    if (ownerInfo.hasCode) throw new Error(`${tag} --owner ${roles.owner} has contract code: the owner must be the cold Ledger (an account with no code)`);
    if (guardianInfo.hasCode) throw new Error(`${tag} --guardian ${roles.guardian} has contract code: the guardian must be the ops key (an account with no code)`);
  }

  // 3. Inputs and constructor arguments.
  const existing = deps.store.read();
  if (existing[RECORD_KEY]) throw new Error(`${tag} ${RECORD_KEY} is already recorded (${existing[RECORD_KEY].address}): this deploy was done; refusing to run it again`);
  const usdc = usdcFromDeployments(existing, deps.networkName);
  const args = buildWithdrawConstructorArgs({
    networkName: deps.networkName,
    usdcWrapper: usdc.wrapper,
    usdcMintBase58: usdc.mintBase58,
    owner: roles.owner,
    guardian: roles.guardian,
  });
  const data = deps.deployData(args);
  const src = await deps.source();
  if (mainnet) {
    if (!src.contractsClean) {
      throw new Error(`${tag} contracts/, hardhat.config.ts or package-lock.json has uncommitted changes (git status --porcelain on them is not empty): on Rubicon the bytecode must come from a clean, reviewed commit`);
    }
    if (!src.build.ok) {
      throw new Error(`${tag} the artifact was not built from the sources and settings on disk, so the bytecode is not the reviewed commit's:\n  - ${src.build.problems.slice(0, 6).join("\n  - ")}\nCompile again from the reviewed checkout (npx hardhat compile; the script does it itself when started as a command)`);
    }
  }

  // On Rubicon a run without --deploy is a dry run, so a skipped step 2 deploys nothing.
  const dryRun = opts.dryRun || (mainnet && !verifying && opts.deployDigest === undefined);
  const mode = verifying ? "VERIFY EXISTING (nothing is sent)" : dryRun ? `DRY RUN (nothing is sent${opts.dryRun ? "" : "; the default on Rubicon"})` : "DEPLOY";

  // The deploy key's nonce sets the address the deploy creates, and it is in the digest.
  const nonce = verifying ? undefined : await deps.nonce();
  const digest = nonce === undefined ? undefined : deployDigest(data, chainId, roles.deployer, nonce);
  const predicted = nonce === undefined ? undefined : predictedAddress(roles.deployer, nonce);

  log(`${tag} chain ${chainId}; mode ${mode}`);
  log(`${tag} deploy key   ${roles.deployer}   (hot; ends with no role)`);
  log(`${tag} owner        ${roles.owner}   (cold Ledger, set in the constructor; balance ${ownerInfo.balance} wei)`);
  log(`${tag} guardian     ${roles.guardian}   (ops key, stop-only)`);
  log(`${tag} USDC wrapper ${usdc.wrapper}   mint ${usdc.mintBase58}`);
  log(`${tag} live v12 record RomeBridgeWithdraw ${existing["RomeBridgeWithdraw"]?.address ?? "(none)"} is not touched`);

  // The v12 owner is the chain's contract admin: the intended v13 owner. A wrong-but-valid owner (the
  // ops key pasted as --owner, another Ledger account) passes every other rule, so on Rubicon it is compared.
  const v12 = existing["RomeBridgeWithdraw"]?.address;
  let v12Owner: Address | undefined;
  if (typeof v12 === "string" && isAddress(v12)) {
    try {
      const read = (await deps.reader(getAddress(v12)).read("owner")) as string;
      if (typeof read === "string" && isAddress(read) && !eq(read, ZERO_ADDRESS)) {
        v12Owner = getAddress(read);
        log(`${tag} v12 owner() is ${v12Owner}; the new owner is ${roles.owner}${eq(v12Owner, roles.owner) ? " (the same)" : " (different)"}. Compare them with the Ledger's own screen.`);
      } else {
        log(`${tag} v12 owner() read as ${String(read)}, not an account; compare --owner with the Ledger's own screen`);
      }
    } catch {
      log(`${tag} v12 owner() could not be read; compare --owner with the Ledger's own screen`);
    }
  }
  if (mainnet) {
    if (v12Owner && eq(roles.guardian, v12Owner)) {
      throw new Error(`${tag} --guardian ${roles.guardian} is v12's owner(): the live owner is the intended v13 OWNER, so --owner and --guardian look swapped (the ops key would end as owner). Refusing, a dry run included.`);
    }
    if (!opts.ownerDiffersFromV12 && !(v12Owner && eq(v12Owner, roles.owner))) {
      // A missing or malformed v12 record counts as an unreadable owner: the safeguard never turns itself off.
      const v12Valid = typeof v12 === "string" && isAddress(v12);
      const why = v12Owner
        ? `--owner ${roles.owner} is not v12's owner() ${v12Owner}`
        : v12Valid
          ? "v12's owner() could not be read as an account, so --owner cannot be compared with it"
          : `deployments/${deps.networkName}.json has no valid RomeBridgeWithdraw (v12) address, so --owner cannot be compared with v12's owner()`;
      if (dryRun) {
        log(`${tag} WARNING: ${why}. A real deploy will be refused unless it is on purpose: then add ${OWNER_DIFFERS_FLAG}.`);
      } else {
        throw new Error(`${tag} ${why}. The chain's contract admin is the intended v13 owner; if the owner really differs, say so on purpose with ${OWNER_DIFFERS_FLAG}.`);
      }
    }
  }
  log(`${tag} source: commit ${src.commit}, contracts/ ${src.contractsClean ? "clean" : "HAS UNCOMMITTED CHANGES"}, artifact ${src.build.ok ? `built from these sources (${src.build.buildInfoId})` : "NOT built from these sources"}`);
  if (!src.build.ok) log(`${tag} WARNING: ${src.build.problems.slice(0, 3).join("; ")}`);
  // The digest is printed only where it cannot be copied into a refused run: the dry run.

  const ownerNeedsGas = mainnet && ownerInfo.balance === 0n;
  if (ownerNeedsGas) log(`${tag} WARNING: the owner holds no Rubicon gas; it needs some to sign the two owner calls (README step 1)`);

  const deployInputHash = keccak256(data);
  let deployed: { address: Address; txHash: Hex };
  let mined: (MinedTx & { blockTimestamp: number }) | undefined;
  let commit = src.commit;

  if (verifying) {
    // 4v. A contract already deployed: it must be this deploy's transaction, built from the commit the operator names.
    const v = opts.verifyExisting!;
    const address = getAddress(v.address);
    const txHash = v.txHash as Hex;
    const at = await deps.sourceAt(v.sourceCommit);
    if (!at.sameSources) throw new Error(`${tag} --source-commit ${v.sourceCommit} cannot be recorded: ${at.problem ?? "its contracts, config and lockfile differ from this checkout's"}. Check out the commit the deploy was run from (or one with identical sources) and run again.`);
    commit = at.commit;
    mined = await fetchMinedDeploy(deps, txHash, "Run --verify-existing again.");
    const problems = deployTxProblems(mined, address, data, roles.deployer);
    if (problems.length > 0) throw new Error(`${tag} ${address} is not this deploy's contract:\n  - ${problems.join("\n  - ")}`);
    deployed = { address, txHash };
    log(`${tag} transaction ${txHash} is the deploy key's creation of ${address} with exactly these bytes; recorded against commit ${commit}`);
  } else {
    const wantDigest = opts.deployDigest;
    if (!dryRun && wantDigest !== undefined && wantDigest.toLowerCase() !== digest!.toLowerCase()) {
      throw new Error(
        `${tag} --deploy ${wantDigest} does not match this deploy (the digest covers the bytecode, constructor arguments, chain, deploy key and the deploy key's nonce). ` +
        "Something changed since the dry run, or a transaction from the deploy key has landed since: check `cast nonce` and the predicted address, then run the dry run again, read it, and use the digest it prints now.",
      );
    }
    if (mainnet) {
      // Both the dry run and the real deploy check the price and the balance.
      const est = await deps.estimate(args);
      if (!est.gasPricePinned || est.gasPrice === undefined) {
        throw new Error(`${tag} RUBICON_GAS_PRICE is not set: Rubicon's proxy rejects "auto" gas prices. export RUBICON_GAS_PRICE=$(( $(cast gas-price -r <rpc>) * 11 / 10 )) and run again`);
      }
      const cost = est.gas * est.gasPrice;
      log(`${tag} estimated gas ${est.gas}, pinned gas price ${est.gasPrice}, cost about ${cost} wei`);
      if (est.balance !== undefined) {
        const enough = est.balance >= cost;
        log(`${tag} deploy key balance ${est.balance} wei${enough ? "" : "  WARNING: below the estimated cost"}`);
        if (!dryRun && !enough) throw new Error(`${tag} the deploy key holds ${est.balance} wei, below the estimated cost ${cost}: fund it and run the dry run again`);
      }
      if (!dryRun && ownerNeedsGas) throw new Error(`${tag} the owner ${roles.owner} holds no Rubicon gas: fund the Ledger first (README step 1), then run the dry run again`);
    }

    // 4. Dry run.
    if (dryRun) {
      log(`${tag} deploy transaction: contract creation of RomeBridgeWithdraw ${EXPECTED_VERSION} from ${roles.deployer}`);
      log(`${tag} deploy key nonce ${nonce}: the contract will be created at ${predicted}`);
      log(`${tag} constructor args:\n${jsonArgs(args)}`);
      log(`${tag} deploy input hash ${deployInputHash}   (keccak256 of the transaction input; after the deploy, cast keccak $(cast tx <hash> input) shows the same)`);
      log(`${tag} deploy digest ${digest}   (bytecode + constructor args + chain + deploy key + nonce)`);
      if (!mainnet) {
        const est = await deps.estimate(args);
        log(`${tag} estimated gas ${est.gas}${est.gasPrice !== undefined ? `, gas price ${est.gasPrice}, cost about ${est.gas * est.gasPrice} wei` : ""}`);
        if (est.balance !== undefined) {
          const enough = est.gasPrice === undefined || est.balance >= est.gas * est.gasPrice;
          log(`${tag} deploy key balance ${est.balance} wei${enough ? "" : "  WARNING: below the estimated cost"}`);
        }
      }
      log(`${tag} DRY RUN: nothing was sent.`);
      if (mainnet) log(`${tag} To deploy, run the same command with --deploy ${digest} (and no --dry-run). The deploy refuses any other digest, and the digest goes stale if the deploy key sends anything first. After the deploy the Ledger signs the two owner calls the real run prints.`);
      else log(`${tag} After the deploy the Ledger signs the two owner calls the real run prints.`);
      return { dryRun: true, chainId, roles, args, digest, nonce };
    }

    // 5a. Send.
    log(`${tag} sending: deploy key nonce ${nonce}, the contract will be created at ${predicted}. If this run stops without a receipt, check \`cast nonce ${roles.deployer}\` and \`cast code ${predicted}\` before anything else: do NOT deploy again.`);
    deployed = await deps.deploy(args, opts.mainnetFlag, opts.deployDigest as Hex | undefined);
    log(`${tag} RomeBridgeWithdraw ${EXPECTED_VERSION} deployed at ${deployed.address} (tx ${deployed.txHash})`);
    if (!eq(deployed.address, predicted!)) {
      throw new Error(
        `${tag} the mined deploy ${deployed.txHash} created ${deployed.address}, not the approved ${predicted} (deploy key nonce ${nonce}), so it is NOT recorded. ` +
        "Do not use that contract and do not enable anything on it, and do NOT deploy again yet. Something else was sent from the deploy key: look the transaction up " +
        `(\`cast tx ${deployed.txHash}\`, \`cast nonce ${roles.deployer}\`, \`cast code ${predicted}\`). Only if you confirm ${deployed.address} is the creation of exactly these bytes by the deploy key and you accept it, ` +
        `record it with ${recoverArgs(deployed.address, deployed.txHash, commit)}; otherwise run the dry run again and start over with the new digest.`,
      );
    }
  }

  // 5b. Read everything back.
  const recover = recoverArgs(deployed.address, deployed.txHash, commit);
  const checked = await verifyWithRetry(deps, deployed.address, deployed.txHash, {
    owner: roles.owner, guardian: roles.guardian, deployer: roles.deployer,
    usdcWrapper: usdc.wrapper, usdcMintBase58: usdc.mintBase58,
  }, recover);
  for (const line of checked) log(`${tag} read back: ${line}`);

  // The hashes a person can check against the chain: the code the node holds now, and the transaction input.
  const chainCode = await deps.reader(deployed.address).getCode().catch(() => undefined);
  if (!chainCode || chainCode === "0x") {
    throw new Error(
      `${tag} the contract ${deployed.address} (tx ${deployed.txHash}) read back correctly but its code could not be read for the record. Nothing was recorded. ` +
      `Do NOT deploy again: re-run with ${recover}.`,
    );
  }
  const codeHash = keccak256(chainCode as Hex);
  if (!mined) {
    // A fresh deploy: the transaction that was MINED must be the approved one (it can be a replacement of the one sent).
    mined = await fetchMinedDeploy(deps, deployed.txHash, `Do NOT deploy again: re-run with ${recover}.`);
    const problems = deployTxProblems(mined, deployed.address, data, roles.deployer, nonce);
    if (problems.length > 0) {
      throw new Error(`${tag} the mined transaction ${deployed.txHash} is not the approved deploy, so ${deployed.address} is NOT recorded. Do not use it, and do NOT deploy again yet (check \`cast tx ${deployed.txHash}\` and \`cast nonce ${roles.deployer}\`; to start over, run the dry run again):\n  - ${problems.join("\n  - ")}`);
    }
  }
  // deployedAt is the deploy block's time, never the clock of this run.
  const deployedAtSec = mined.blockTimestamp;
  log(`${tag} code hash ${codeHash}   (keccak256 of eth_getCode ${deployed.address})`);
  log(`${tag} deploy input hash ${deployInputHash}   (keccak256 of the input of ${deployed.txHash})`);

  // 6. Record it, beside v12.
  const record: V13Record = {
    address: deployed.address,
    version: EXPECTED_VERSION,
    owner: roles.owner,
    guardian: roles.guardian,
    deployTx: deployed.txHash,
    deployedAt: deployedAtSec,
    commit,
    build: { buildInfoId: src.build.buildInfoId, solcVersion: src.build.solcVersion ?? "unknown" },
    codeHash,
    deployInputHash,
  };
  try {
    if (deps.store.update) deps.store.update((cur) => withV13Record(cur, record));
    else deps.store.write(withV13Record(deps.store.read(), record));
  } catch (e) {
    log(`${tag} COULD NOT WRITE the record (${(e as Error).message.split("\n")[0]}). It read back correctly. Add this under "${RECORD_KEY}" by hand:\n${jsonArgs(record)}`);
    throw new Error(
      `${tag} the contract ${deployed.address} (tx ${deployed.txHash}) read back correctly but deployments/${deps.networkName}.json could not be written. ` +
      `Do NOT deploy again: fix the file problem and re-run with ${recover}.`,
    );
  }
  log(`${tag} wrote ${RECORD_KEY} to deployments/${deps.networkName}.json (the registry switch-over is a separate step)`);

  // 7. Print the owner calls.
  const ownerCalls = buildOwnerCalls(deployed.address, usdc.mintBase58);
  log(`\n${tag} OWNER CALLS: ${ownerCalls.length}, in this order. The cold Ledger (${roles.owner}) signs and sends each one. This script does not send them.`);
  log(`${tag} The owner needs Rubicon gas. The Wormhole allowlists stay empty: no call for them.`);
  for (const [i, c] of ownerCalls.entries()) {
    log(`\n[${i + 1}] ${c.description}`);
    log(`    to:    ${c.to}`);
    log(`    value: ${c.value}`);
    log(`    data:  ${c.data}`);
    if (deps.simulate) {
      try {
        await deps.simulate(roles.owner, c);
        log("    dry run as owner: ok");
      } catch (e) {
        log(`    dry run as owner: FAILED (${(e as Error).message.split("\n")[0]}). Read this before signing.`);
      }
    }
  }
  return { dryRun: false, chainId, roles, args, digest, nonce, deployed, ownerCalls };
}
