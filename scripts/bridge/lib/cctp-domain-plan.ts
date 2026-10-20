// scripts/bridge/lib/cctp-domain-plan.ts
//
// Pure helpers for scripts/bridge/enable-cctp-domains.ts: parse the wanted
// domain list, diff it against what the contract reports on chain, and encode the
// owner calls that would close the gap. No network, no keys.

import { encodeFunctionData, parseAbi, type Hex } from "viem";

/** Mirrors RomeBridgeWithdraw.RECIPIENT_EVM / RECIPIENT_RAW32. */
export const KIND_EVM = 1;
export const KIND_RAW32 = 2;
export type RecipientKind = typeof KIND_EVM | typeof KIND_RAW32;

/** Circle's domain id for Solana; the contract refuses it. */
export const DOMAIN_SOLANA = 5;

export const KIND_NAME: Record<number, string> = { 1: "EVM", 2: "RAW32" };

export interface DomainEntry {
  domain: number;
  kind: RecipientKind;
}

/** The slice of the RomeBridgeWithdraw ABI the ops script uses. */
export const CCTP_ADMIN_ABI = parseAbi([
  "function owner() view returns (address)",
  "function guardian() view returns (address)",
  "function VERSION() view returns (string)",
  "function cctpDomains() view returns (uint32[])",
  "function cctpRecipientKind(uint32 domain) view returns (uint8)",
  "function cctpRemoteTokenMessengers(uint32 domain) view returns (bytes32)",
  "function enableCctpDomain(uint32 domain, uint8 recipientKind)",
  "function disableCctpDomain(uint32 domain)",
]);

/**
 * Parses "0,1,3,6:evm,8:raw32". A bare number means an EVM recipient. Rejects an
 * empty list, duplicates, anything that is not a uint32, and domain 5 (Solana,
 * which the contract refuses).
 */
export function parseDomainSpec(spec: string): DomainEntry[] {
  const parts = spec.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error("--domains is empty");
  const out: DomainEntry[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    const [num, kindRaw, extra] = part.split(":");
    if (extra !== undefined) throw new Error(`bad domain entry "${part}"`);
    if (!/^\d+$/.test(num)) throw new Error(`bad domain "${num}": not a whole number`);
    const domain = Number(num);
    if (!Number.isSafeInteger(domain) || domain > 0xffffffff) throw new Error(`domain ${num} does not fit a uint32`);
    if (domain === DOMAIN_SOLANA) throw new Error("domain 5 is Solana: an address-typed burn there is unredeemable, the contract refuses it");
    let kind: RecipientKind = KIND_EVM;
    if (kindRaw !== undefined) {
      const k = kindRaw.toLowerCase();
      if (k === "evm") kind = KIND_EVM;
      else if (k === "raw32") kind = KIND_RAW32;
      else throw new Error(`bad recipient kind "${kindRaw}" for domain ${domain}: use evm or raw32`);
    }
    if (seen.has(domain)) throw new Error(`domain ${domain} is listed twice`);
    seen.add(domain);
    out.push({ domain, kind });
  }
  return out;
}

export interface PlannedCall {
  fn: "enableCctpDomain" | "disableCctpDomain";
  domain: number;
  kind?: RecipientKind;
  /** Why the call is needed. */
  reason: "missing on chain" | "kind differs" | "not wanted";
  data: Hex;
}

export interface Plan {
  calls: PlannedCall[];
  unchanged: DomainEntry[];
}

export function encodeEnable(domain: number, kind: RecipientKind): Hex {
  return encodeFunctionData({ abi: CCTP_ADMIN_ABI, functionName: "enableCctpDomain", args: [domain, kind] });
}

export function encodeDisable(domain: number): Hex {
  return encodeFunctionData({ abi: CCTP_ADMIN_ABI, functionName: "disableCctpDomain", args: [domain] });
}

/**
 * Diffs the wanted list against the chain, in both directions: a wanted domain
 * that is missing (or has another kind) gets an enable call, an enabled domain
 * that is not wanted gets a disable call. Calls come out sorted by domain, with
 * disables last, so the printed order is stable and reviewable.
 */
export function planDomainChanges(wanted: DomainEntry[], onChain: DomainEntry[]): Plan {
  const chain = new Map(onChain.map((e) => [e.domain, e.kind]));
  const want = new Map(wanted.map((e) => [e.domain, e.kind]));
  const calls: PlannedCall[] = [];
  const unchanged: DomainEntry[] = [];

  for (const e of [...wanted].sort((a, b) => a.domain - b.domain)) {
    const have = chain.get(e.domain);
    if (have === undefined) {
      calls.push({ fn: "enableCctpDomain", domain: e.domain, kind: e.kind, reason: "missing on chain", data: encodeEnable(e.domain, e.kind) });
    } else if (have !== e.kind) {
      calls.push({ fn: "enableCctpDomain", domain: e.domain, kind: e.kind, reason: "kind differs", data: encodeEnable(e.domain, e.kind) });
    } else {
      unchanged.push(e);
    }
  }
  for (const e of [...onChain].sort((a, b) => a.domain - b.domain)) {
    if (!want.has(e.domain)) {
      calls.push({ fn: "disableCctpDomain", domain: e.domain, reason: "not wanted", data: encodeDisable(e.domain) });
    }
  }
  return { calls, unchanged };
}

// ── Wanted list from the bridge registry ───────────────────────────────────

/**
 * The wanted CCTP domains in a registry `bridge.json`. Reads `sourceEvms[]` (or
 * the older single `sourceEvm`), and takes every entry that has a `cctpDomain`
 * and is `preparing` or `live` (no status counts as live): a chain is enabled
 * on chain while it is still `preparing`, before the route is shown. Any other
 * status is left out, so the chain would be disabled. An entry may carry
 * `cctpRecipientKind: "raw32"` for a non-EVM chain; the default is EVM.
 * Domain 5 (Solana) is refused.
 */
export function domainsFromRegistry(registry: unknown): DomainEntry[] {
  const root = registry as { sourceEvms?: unknown; sourceEvm?: unknown };
  const entries: unknown[] = Array.isArray(root?.sourceEvms)
    ? root.sourceEvms
    : root?.sourceEvm ? [root.sourceEvm] : [];
  const out: DomainEntry[] = [];
  const seen = new Set<number>();
  for (const raw of entries) {
    const e = raw as { cctpDomain?: unknown; status?: unknown; cctpRecipientKind?: unknown; name?: unknown };
    if (e.cctpDomain === undefined || e.cctpDomain === null) continue;
    const status = e.status === undefined ? "live" : e.status;
    if (status !== "live" && status !== "preparing") continue;
    const domain = e.cctpDomain;
    if (typeof domain !== "number" || !Number.isSafeInteger(domain) || domain < 0 || domain > 0xffffffff) {
      throw new Error(`registry entry ${String(e.name ?? "?")} has a bad cctpDomain: ${String(domain)}`);
    }
    if (domain === DOMAIN_SOLANA) throw new Error("registry lists CCTP domain 5 (Solana) as a destination: the contract refuses it");
    if (seen.has(domain)) throw new Error(`registry lists CCTP domain ${domain} twice`);
    seen.add(domain);
    const kindRaw = typeof e.cctpRecipientKind === "string" ? e.cctpRecipientKind.toLowerCase() : "evm";
    if (kindRaw !== "evm" && kindRaw !== "raw32") throw new Error(`registry entry for domain ${domain} has a bad cctpRecipientKind "${String(e.cctpRecipientKind)}"`);
    out.push({ domain, kind: kindRaw === "raw32" ? KIND_RAW32 : KIND_EVM });
  }
  if (out.length === 0) throw new Error("the registry lists no CCTP destination (nothing live or preparing with a cctpDomain)");
  return out;
}

// ── Send decision ──────────────────────────────────────────────────────────

/** Chains where the script must never send, whatever the network is called. */
export const MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([7531]);

export interface SendInput {
  /** A network name this script knows (so its chain id could be checked). */
  knownNetwork: boolean;
  /** The network is declared mainnet in the script's table. */
  declaredMainnet: boolean;
  /** The chain id the RPC reported. */
  chainId: number;
  wantSend: boolean;
  /** Address of the key found in the environment, if any. */
  signer?: string;
  owner: string;
}

export interface SendDecision {
  send: boolean;
  /** Why not (or "ok"). Printed to the operator. */
  reason: string;
}

/**
 * Whether the script may send the planned calls. It may only when every
 * condition holds: --send was given, the network is a known one, neither the
 * table nor the live chain id says mainnet, a key is present, and that key is
 * the contract's owner. The chain id is what counts: Rubicon under any name or
 * through any RPC url is refused.
 */
export function canSend(i: SendInput): SendDecision {
  if (!i.wantSend) return { send: false, reason: "--send was not given (print mode)" };
  if (i.declaredMainnet || MAINNET_CHAIN_IDS.has(i.chainId)) {
    return { send: false, reason: `chain ${i.chainId} is mainnet: print-only, sign the calldata with the cold Ledger` };
  }
  if (!i.knownNetwork) return { send: false, reason: "the network is not one this script knows, so --send is refused (print only)" };
  if (!i.signer) return { send: false, reason: "no signer key in the environment (print mode only)" };
  if (i.signer.toLowerCase() !== i.owner.toLowerCase()) {
    return { send: false, reason: `the signer ${i.signer} is not the owner ${i.owner} (print mode only)` };
  }
  return { send: true, reason: "ok" };
}

// ── Circle's record, re-read on --check ────────────────────────────────────

/** Circle's RemoteTokenMessenger discriminator: sha256("account:RemoteTokenMessenger")[..8]. */
export const REMOTE_TOKEN_MESSENGER_DISCRIMINATOR = "6973ae225fe98afc";

export interface SolanaAccount {
  owner: string;
  data: Uint8Array;
}

/**
 * Checks Circle's live RemoteTokenMessenger record for an enabled domain, the
 * same facts `enableCctpDomain` checked on the day it was enabled: owned by the
 * v2 Token Messenger Minter, Circle's discriminator, the stored domain, and for
 * an EVM-kind domain a messenger with 12 leading zero bytes. Returns a problem
 * text, or null when the record still holds. A domain Circle removed or changed
 * after Rome enabled it shows up here, not in a burn.
 */
export function checkCircleRecord(
  domain: number, kind: number, account: SolanaAccount | null, tokenMessengerMinterProgram: string,
): string | null {
  if (!account) return `Circle has no RemoteTokenMessenger account for domain ${domain} any more`;
  if (account.owner !== tokenMessengerMinterProgram) return `domain ${domain}: the account is owned by ${account.owner}, not the CCTP v2 Token Messenger Minter`;
  const d = account.data;
  if (d.length < 44) return `domain ${domain}: the account is too short (${d.length} bytes)`;
  const disc = Buffer.from(d.subarray(0, 8)).toString("hex");
  if (disc !== REMOTE_TOKEN_MESSENGER_DISCRIMINATOR) return `domain ${domain}: wrong account discriminator ${disc}`;
  const stored = d[8] | (d[9] << 8) | (d[10] << 16) | (d[11] * 0x1000000);
  if (stored !== domain) return `domain ${domain}: the account records domain ${stored}`;
  if (kind === KIND_EVM && d.subarray(12, 24).some((b) => b !== 0)) {
    return `domain ${domain}: Circle's messenger is no longer EVM-shaped (${Buffer.from(d.subarray(12, 44)).toString("hex")}), but Rome has it as an EVM destination`;
  }
  return null;
}
