// scripts/bridge/lib/deploy-roles.ts
//
// Pure decision for who owns and who guards a new RomeBridgeWithdraw 13.x. No
// network, no keys. Used by scripts/bridge/deploy.ts and tested on its own.

const ZERO = "0x0000000000000000000000000000000000000000";

export interface RoleInput {
  network: string;
  isMainnet: boolean;
  deployer: string;
  /** BRIDGE_OWNER */
  bridgeOwner?: string;
  /** WORMHOLE_ADMIN, a v12 leftover: honoured off mainnet only. */
  wormholeAdmin?: string;
  /** BRIDGE_GUARDIAN */
  bridgeGuardian?: string;
}

export interface Roles {
  owner: string;
  guardian: string;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Mainnet: BRIDGE_OWNER and BRIDGE_GUARDIAN are both required, WORMHOLE_ADMIN is
 * ignored, the owner must not be the deploy key, the guardian must not be the
 * owner. Elsewhere the owner falls back to WORMHOLE_ADMIN, then the deployer,
 * and the guardian to none; the guardian-differs rule still applies.
 */
export function resolveRoles(i: RoleInput): Roles {
  const owner = i.isMainnet ? i.bridgeOwner : (i.bridgeOwner ?? i.wormholeAdmin);
  if (i.isMainnet && !owner) {
    throw new Error(`[${i.network}] BRIDGE_OWNER is required on mainnet (the cold Ledger address)`);
  }
  if (i.isMainnet && !i.bridgeGuardian) {
    throw new Error(`[${i.network}] BRIDGE_GUARDIAN is required on mainnet (the ops key that can only stop things)`);
  }
  const resolvedOwner = owner ?? i.deployer;
  const guardian = i.bridgeGuardian ?? ZERO;
  if (i.isMainnet && eq(resolvedOwner, i.deployer)) {
    throw new Error(`[${i.network}] the owner must not be the deploy key (${i.deployer}): use the cold Ledger address`);
  }
  if (guardian !== ZERO && eq(guardian, resolvedOwner)) {
    throw new Error(`[${i.network}] the guardian must differ from the owner (${resolvedOwner}): the guardian is the stop-only key`);
  }
  return { owner: resolvedOwner, guardian };
}
