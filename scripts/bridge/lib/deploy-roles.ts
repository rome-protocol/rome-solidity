// scripts/bridge/lib/deploy-roles.ts
//
// Pure decision for who owns and who guards a new RomeBridgeWithdraw 13.x on a testnet.
// No network, no keys. Used by scripts/bridge/deploy.ts and tested on its own.
// There is no mainnet rule here: deploy.ts cannot send on Rubicon, and the Rubicon deploy
// (deploy-rubicon-v13.ts) brings its own role checks (owner = cold Ledger, guardian =
// ops key, owner != deploy key).

const ZERO = "0x0000000000000000000000000000000000000000";

export interface RoleInput {
  network: string;
  deployer: string;
  /** BRIDGE_OWNER */
  bridgeOwner?: string;
  /** WORMHOLE_ADMIN, a v12 leftover. */
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
 * The owner is BRIDGE_OWNER, else WORMHOLE_ADMIN, else the deployer; the guardian is
 * BRIDGE_GUARDIAN, else none. The guardian must not be the owner.
 */
export function resolveRoles(i: RoleInput): Roles {
  const resolvedOwner = i.bridgeOwner ?? i.wormholeAdmin ?? i.deployer;
  const guardian = i.bridgeGuardian ?? ZERO;
  if (guardian !== ZERO && eq(guardian, resolvedOwner)) {
    throw new Error(`[${i.network}] the guardian must differ from the owner (${resolvedOwner}): the guardian is the stop-only key`);
  }
  return { owner: resolvedOwner, guardian };
}
