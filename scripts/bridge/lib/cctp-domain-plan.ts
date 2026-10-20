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
