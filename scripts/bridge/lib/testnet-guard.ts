// scripts/bridge/lib/testnet-guard.ts
//
// One fail-closed gate for every script in scripts/bridge that SENDS a
// transaction. It looks at the chain id the RPC actually reports (eth_chainId),
// never at the network's name or the URL, and lets a send through only when that
// id is on the testnet allowlist below. Anything else is refused: Rubicon
// (mainnet, 7531), a chain id nobody listed, an RPC that does not answer, an
// answer that is not a number.
//
// There is no flag, environment variable or option that makes a script send on
// mainnet. On Rubicon the scripts either only PRINT the calldata for a Ledger to
// sign (enable-cctp-domains.ts) or refuse (everything else).
//
// A local Rome stack has a chain id of its own. To use one, list it on purpose:
//   ROME_EXTRA_TESTNET_CHAIN_IDS=1234,5678
// Mainnet ids are refused even if they are listed there.

/** Chain ids the scripts may send on. Name is for messages only. */
export const TESTNET_CHAIN_IDS: ReadonlyMap<number, string> = new Map([
  [200010, "hadrian"],
  [121214, "martius"],
  [121213, "subura"],
  [121302, "trajan"],
  [210000, "nerva"],
  [31337, "hardhat in-process network"],
]);

/** Chain ids that are never sent on, whatever else is configured. */
export const MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([7531]);

export const EXTRA_ENV = "ROME_EXTRA_TESTNET_CHAIN_IDS";

export interface ChainVerdict {
  allowed: boolean;
  /** Printed to the operator. */
  reason: string;
}

/** Whole-number chain ids from the ROME_EXTRA_TESTNET_CHAIN_IDS value. Bad entries are ignored (fail closed). */
export function parseExtraChainIds(raw: string | undefined): Set<number> {
  const out = new Set<number>();
  for (const part of (raw ?? "").split(",")) {
    const t = part.trim();
    if (!/^\d+$/.test(t)) continue;
    const n = Number(t);
    if (Number.isSafeInteger(n) && n > 0) out.add(n);
  }
  return out;
}

/**
 * Pure decision. `chainId` is what the RPC reported (undefined or NaN when it
 * could not be read, which is refused).
 */
export function judgeChain(chainId: number | undefined, extraEnv?: string): ChainVerdict {
  if (chainId === undefined || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return { allowed: false, reason: `the RPC did not report a usable chain id (${String(chainId)}): refusing to send` };
  }
  if (MAINNET_CHAIN_IDS.has(chainId)) {
    return { allowed: false, reason: `chain ${chainId} is mainnet: this script never sends there (print the calldata and sign it with the cold Ledger)` };
  }
  const known = TESTNET_CHAIN_IDS.get(chainId);
  if (known) return { allowed: true, reason: `chain ${chainId} (${known}) is a testnet` };
  if (parseExtraChainIds(extraEnv).has(chainId)) {
    return { allowed: true, reason: `chain ${chainId} is listed in ${EXTRA_ENV}` };
  }
  return { allowed: false, reason: `chain ${chainId} is not on the testnet allowlist: refusing to send (list a local stack on purpose with ${EXTRA_ENV})` };
}

/** Throws unless the chain id is an allowed testnet. `what` names the script, for the message. */
export function assertTestnetChainId(chainId: number | undefined, what: string, extraEnv: string | undefined = process.env[EXTRA_ENV]): void {
  const v = judgeChain(chainId, extraEnv);
  if (!v.allowed) throw new Error(`[${what}] ${v.reason}`);
}

/** Anything with viem's `getChainId()`. */
export interface ChainIdSource {
  getChainId(): Promise<number>;
}

/** Reads the live chain id from a viem public client and asserts it is a testnet. Returns the id. */
export async function assertTestnetSend(client: ChainIdSource, what: string, extraEnv: string | undefined = process.env[EXTRA_ENV]): Promise<number> {
  let chainId: number | undefined;
  try {
    chainId = Number(await client.getChainId());
  } catch (e) {
    throw new Error(`[${what}] cannot read the chain id from the RPC (${(e as Error).message.split("\n")[0]}): refusing to send`);
  }
  assertTestnetChainId(chainId, what, extraEnv);
  return chainId;
}

/**
 * Same check for a script that has only an RPC url (ethers or a plain fetch):
 * asks the RPC for eth_chainId itself.
 */
export async function assertTestnetRpc(
  rpcUrl: string,
  what: string,
  fetchImpl: typeof fetch = fetch,
  extraEnv: string | undefined = process.env[EXTRA_ENV],
): Promise<number> {
  let chainId: number | undefined;
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Rome Protocol rome@romeprotocol.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    const body = (await res.json()) as { result?: unknown };
    chainId = typeof body.result === "string" && /^0x[0-9a-fA-F]+$/.test(body.result) ? Number(BigInt(body.result)) : undefined;
  } catch (e) {
    throw new Error(`[${what}] cannot read eth_chainId from ${rpcUrl} (${(e as Error).message.split("\n")[0]}): refusing to send`);
  }
  assertTestnetChainId(chainId, what, extraEnv);
  return chainId!;
}

// ── Solana side ────────────────────────────────────────────────────────────

/** Genesis hashes of Solana's devnet and testnet. Mainnet-beta (5eykt4Us...) is deliberately absent. */
export const SOLANA_TESTNET_GENESIS: ReadonlyMap<string, string> = new Map([
  ["EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "devnet"],
  ["4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY", "testnet"],
]);

/** Pure: is this Solana genesis hash a devnet or testnet one? Anything else (mainnet, unknown, unreadable) is refused. */
export function judgeSolanaGenesis(genesisHash: string | undefined): ChainVerdict {
  if (!genesisHash) return { allowed: false, reason: "the Solana RPC did not report a genesis hash: refusing to send" };
  const name = SOLANA_TESTNET_GENESIS.get(genesisHash);
  if (name) return { allowed: true, reason: `Solana ${name} (genesis ${genesisHash})` };
  return { allowed: false, reason: `Solana genesis hash ${genesisHash} is not devnet or testnet: refusing to send` };
}

/** Asks a Solana RPC for its genesis hash and refuses unless it is devnet or testnet. */
export async function assertSolanaTestnetRpc(
  rpcUrl: string,
  what: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let hash: string | undefined;
  try {
    const res = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Rome Protocol rome@romeprotocol.com" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }),
    });
    const body = (await res.json()) as { result?: unknown };
    hash = typeof body.result === "string" ? body.result : undefined;
  } catch (e) {
    throw new Error(`[${what}] cannot read the genesis hash from ${rpcUrl} (${(e as Error).message.split("\n")[0]}): refusing to send`);
  }
  const v = judgeSolanaGenesis(hash);
  if (!v.allowed) throw new Error(`[${what}] ${v.reason}`);
  return hash!;
}
