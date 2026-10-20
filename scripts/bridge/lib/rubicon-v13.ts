// scripts/bridge/lib/rubicon-v13.ts
//
// The logic behind scripts/bridge/deploy-rubicon-v13.ts, with every outside
// dependency (the chain, the deployments file, the clock) passed in, so the
// tests run it on a local Hardhat chain and never need a live network.
//
// What the deploy does, in order:
//   1. asks the guard whether this chain may be touched (chain 7531 only with
//      --i-understand-mainnet; lib/testnet-guard.ts)
//   2. checks the roles: owner = the cold Ledger, guardian = the ops key, both
//      given explicitly, neither zero, neither the deploy key, not each other
//   3. builds the constructor arguments (lib/withdraw-ctor-args.ts, the same ones
//      deploy.ts uses on the testnets)
//   4. --dry-run: estimates gas, prints the deploy transaction and the arguments,
//      and stops. Nothing is sent.
//   5. deploys with the hot deploy key, reads everything back, and fails loudly on
//      any mismatch (and then writes nothing)
//   6. records the address under RomeBridgeWithdrawV13 in deployments/<network>.json,
//      next to the live v12 record and without touching it
//   7. PRINTS the owner calls the Ledger signs. It never sends them.

import { encodeFunctionData, getAddress, isAddress, parseAbi, type Hex } from "viem";
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
}

export const USAGE =
  "usage: npx tsx scripts/bridge/deploy-rubicon-v13.ts --network <name> --owner <ledger address> --guardian <ops key address> " +
  `[--dry-run] [${MAINNET_FLAG}]`;

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
    if (a === "--dry-run" || a === MAINNET_FLAG) {
      name = a;
      value = true;
    } else if (a === "--network" || a === "--owner" || a === "--guardian") {
      name = a;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${a} needs a value. ${USAGE}`);
      value = next;
      i++;
    } else if (/^--(network|owner|guardian)=/.test(a)) {
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
  const opts: DeployOptions = {
    network: need("--network"),
    owner: need("--owner"),
    guardian: need("--guardian"),
    dryRun: seen.has("--dry-run"),
    mainnetFlag: seen.has(MAINNET_FLAG),
  };
  if (opts.network === RUBICON_NETWORK && !opts.mainnetFlag) {
    throw new Error(`--network ${RUBICON_NETWORK} is mainnet: pass ${MAINNET_FLAG} (start with --dry-run). ${USAGE}`);
  }
  return opts;
}

// ── Roles ──────────────────────────────────────────────────────────────────

export interface Roles {
  owner: Address;
  guardian: Address;
  deployer: Address;
}

function parseAddress(label: string, v: string): Address {
  if (!isAddress(v)) throw new Error(`${label} "${v}" is not a 20-byte address (mixed-case addresses must have a valid checksum)`);
  return getAddress(v);
}

/**
 * owner = the cold Ledger, guardian = the ops key, deployer = the hot deploy key.
 * All three are different, and none is zero. The deploy key ends the deploy with no role.
 */
export function validateRoles(i: { deployer: string; owner: string; guardian: string }): Roles {
  const owner = parseAddress("--owner", i.owner);
  const guardian = parseAddress("--guardian", i.guardian);
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

/** The two calls the cold Ledger signs after the deploy. Printed, never sent. */
export function buildOwnerCalls(bridge: Address, usdcMintBase58: string): OwnerCall[] {
  const mint = base58ToBytes32(usdcMintBase58);
  return [
    {
      description: `enableCctpDomain(${ETHEREUM_DOMAIN}, ${RECIPIENT_EVM}): enable Ethereum (CCTP domain 0) as an EVM-recipient destination. The contract derives and checks Circle's RemoteTokenMessenger account itself.`,
      to: bridge,
      data: encodeFunctionData({ abi: OWNER_ABI, functionName: "enableCctpDomain", args: [ETHEREUM_DOMAIN, RECIPIENT_EVM] }),
      value: "0",
    },
    {
      description: `ensureBridgeAta(${mint}): create the bridge's USDC token account (mint ${usdcMintBase58}); paid from the operator's rent, so it is owner-only. Needed once before the first burn.`,
      to: bridge,
      data: encodeFunctionData({ abi: OWNER_ABI, functionName: "ensureBridgeAta", args: [mint] }),
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
}

export interface V13Record {
  address: Address;
  version: string;
  owner: Address;
  guardian: Address;
  deployTx: Hex;
  deployedAt: number;
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

export interface DeployDeps {
  networkName: string;
  /** The hot deploy key's address (the key itself never leaves the wallet client). */
  deployer: string;
  /**
   * Asks the guard about the chain the RPC reports; resolves with its id or throws. The
   * script wires it with its own file path, so the guard sees who is really calling.
   */
  guard(mainnetFlag: boolean): Promise<number>;
  store: DeploymentStore;
  /** Gas for the deploy transaction, from the node. A dry run sends nothing. */
  estimate(args: ReturnType<typeof buildWithdrawConstructorArgs>): Promise<{ gas: bigint; gasPrice?: bigint; balance?: bigint }>;
  /** Sends the deploy transaction and waits for it to be mined. */
  deploy(args: ReturnType<typeof buildWithdrawConstructorArgs>): Promise<{ address: Address; txHash: Hex }>;
  reader(address: Address): ChainReader;
  /** eth_call of an owner call from the owner's address; the answer is printed, never fatal. */
  simulate?(from: Address, call: OwnerCall): Promise<void>;
  now(): number;
  log(line: string): void;
}

export interface DeployResult {
  dryRun: boolean;
  chainId: number;
  roles: Roles;
  args: ReturnType<typeof buildWithdrawConstructorArgs>;
  deployed?: { address: Address; txHash: Hex };
  ownerCalls?: OwnerCall[];
}

function jsonArgs(args: unknown): string {
  return JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
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

  // 2. Roles.
  const roles = validateRoles({ deployer: deps.deployer, owner: opts.owner, guardian: opts.guardian });

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

  log(`${tag} chain ${chainId}; mode ${opts.dryRun ? "DRY RUN (nothing is sent)" : "DEPLOY"}`);
  log(`${tag} deploy key   ${roles.deployer}   (hot; ends with no role)`);
  log(`${tag} owner        ${roles.owner}   (cold Ledger, set in the constructor)`);
  log(`${tag} guardian     ${roles.guardian}   (ops key, stop-only)`);
  log(`${tag} USDC wrapper ${usdc.wrapper}   mint ${usdc.mintBase58}`);
  log(`${tag} live v12 record RomeBridgeWithdraw ${existing["RomeBridgeWithdraw"]?.address ?? "(none)"} is not touched`);

  // 4. Dry run.
  if (opts.dryRun) {
    const est = await deps.estimate(args);
    log(`${tag} deploy transaction: contract creation of RomeBridgeWithdraw ${EXPECTED_VERSION} from ${roles.deployer}`);
    log(`${tag} constructor args:\n${jsonArgs(args)}`);
    log(`${tag} estimated gas ${est.gas}${est.gasPrice !== undefined ? `, gas price ${est.gasPrice}, cost about ${est.gas * est.gasPrice} wei` : ""}`);
    if (est.balance !== undefined) {
      const enough = est.gasPrice === undefined || est.balance >= est.gas * est.gasPrice;
      log(`${tag} deploy key balance ${est.balance} wei${enough ? "" : "  WARNING: below the estimated cost"}`);
    }
    log(`${tag} DRY RUN: nothing was sent. After the deploy the Ledger signs the two owner calls printed by the real run.`);
    return { dryRun: true, chainId, roles, args };
  }

  // 5. Deploy, then read everything back.
  const deployed = await deps.deploy(args);
  log(`${tag} RomeBridgeWithdraw ${EXPECTED_VERSION} deployed at ${deployed.address} (tx ${deployed.txHash})`);
  let checked: string[];
  try {
    checked = await verifyDeployment(deps.reader(deployed.address), {
      owner: roles.owner, guardian: roles.guardian, deployer: roles.deployer,
      usdcWrapper: usdc.wrapper, usdcMintBase58: usdc.mintBase58,
    });
  } catch (e) {
    throw new Error(
      `${tag} the contract at ${deployed.address} (tx ${deployed.txHash}) FAILED the read-back and was NOT recorded. ` +
      `Do not use it; do not enable anything on it.\n${(e as Error).message}`,
    );
  }
  for (const line of checked) log(`${tag} read back: ${line}`);

  // 6. Record it, beside v12.
  deps.store.write(withV13Record(deps.store.read(), {
    address: deployed.address,
    version: EXPECTED_VERSION,
    owner: roles.owner,
    guardian: roles.guardian,
    deployTx: deployed.txHash,
    deployedAt: Math.floor(deps.now() / 1000),
  }));
  log(`${tag} wrote ${RECORD_KEY} to deployments/${deps.networkName}.json (the registry switch-over is a separate step)`);

  // 7. Print the owner calls.
  const ownerCalls = buildOwnerCalls(deployed.address, usdc.mintBase58);
  log(`\n${tag} OWNER CALLS: ${ownerCalls.length}. The cold Ledger (${roles.owner}) signs and sends each one. This script does not send them.`);
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
  return { dryRun: false, chainId, roles, args, deployed, ownerCalls };
}
