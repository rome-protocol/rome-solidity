// scripts/bridge/lib/burn-recipient.ts
//
// Who a test burn pays. The old submit-burn.ts / try-burn.ts burned to the
// fixed address 0x...0001, so every successful test lost its tokens. A test burn
// now goes to an address the operator controls: by default the signer's own
// address (the same key controls it on the destination chain), or an address given
// explicitly in BURN_RECIPIENT. Zero and "burn-like" low addresses are refused.
// Pure: no network, no keys.

import { getAddress, isAddress } from "viem";

/** Addresses below 2^32 (0x0, 0x1, precompiles, ...) are never anyone's wallet. */
const LOWEST_ACCEPTED = 1n << 32n;

export function resolveBurnRecipient(signer: string, explicit?: string): `0x${string}` {
  if (!isAddress(signer)) throw new Error(`signer ${signer} is not an address`);
  const raw = (explicit ?? "").trim();
  const chosen = raw === "" ? signer : raw;
  if (!isAddress(chosen)) throw new Error(`BURN_RECIPIENT ${chosen} is not a 20-byte 0x address`);
  const checksummed = getAddress(chosen);
  if (BigInt(checksummed) < LOWEST_ACCEPTED) {
    throw new Error(`burn recipient ${checksummed} is a burn-like address (below 2^32): tokens sent there are lost. Use an address you control`);
  }
  return checksummed;
}

/** Whole base-unit amount from an env value, default 100000 (0.1 USDC). */
export function resolveBurnAmount(raw?: string): bigint {
  const t = (raw ?? "").trim();
  if (t === "") return 100_000n;
  if (!/^\d+$/.test(t)) throw new Error(`BURN_AMOUNT ${t} is not a whole number of base units`);
  const n = BigInt(t);
  if (n === 0n) throw new Error("BURN_AMOUNT is zero");
  return n;
}
