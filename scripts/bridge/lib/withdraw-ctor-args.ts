// scripts/bridge/lib/withdraw-ctor-args.ts
//
// The RomeBridgeWithdraw 13.x constructor arguments, in one place. Both
// scripts/bridge/deploy.ts (testnets) and scripts/bridge/deploy-rubicon-v13.ts
// (Rubicon) build them here, so a Rubicon deploy cannot drift from the one
// that was rehearsed on a testnet. No network, no keys.
//
// The Solana program ids follow the cluster the Rome chain settles on
// (lib/wormhole-target-chain.ts): devnet chains get the devnet Wormhole ids,
// every other name (Rubicon) gets the mainnet-beta ids. CCTP v2 ids are the same
// on both clusters.

import { PublicKey } from "@solana/web3.js";
import { base58ToBytes32 } from "../../lib/pubkey.js";
import { SOLANA_PROGRAM_IDS, SOLANA_PROGRAM_IDS_DEVNET } from "../constants.js";
import { deriveCctpAccounts } from "../derive/cctp-accounts.js";
import { deriveWormholeGlobalAccounts } from "../derive/wormhole-accounts.js";
import { SOLANA_DEVNET_NETWORKS } from "./wormhole-target-chain.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// Networks on Solana DEVNET use the devnet Wormhole/CCTP program ids AND bridge
// to Sepolia; the ONE set lives in lib/wormhole-target-chain.ts so the two can
// never disagree again (Martius/Nerva shipped with Ethereum as target).
function programIdsFor(networkName: string) {
  return SOLANA_DEVNET_NETWORKS.has(networkName) ? SOLANA_PROGRAM_IDS_DEVNET : SOLANA_PROGRAM_IDS;
}

// Cluster-aware UNIVERSAL block. Wormhole Token Bridge / Core program IDs
// vary per cluster; CCTP and SPL Token / System Program are identical
// across clusters.
export function universalFor(networkName: string) {
  const ids = programIdsFor(networkName);
  return {
    splTokenProgram:             base58ToBytes32(ids.SPL_TOKEN),
    systemProgram:               base58ToBytes32(ids.SYSTEM_PROGRAM),
    wormholeTokenBridgeProgram:  base58ToBytes32(ids.WORMHOLE_TOKEN_BRIDGE),
    // v6: the CPI target MUST be the CCTP v2 programs — the constructor's
    // config PDAs, the instruction data, and the account list are all v2
    // (derive/cctp-accounts.ts). Wiring the v1 ids here (the pre-v6 default)
    // makes every burnUSDC revert at the v2 program's owner/seed validation
    // — fund-safe but 100% non-functional (audit C1, rome-solidity #264).
    cctpTokenMessengerProgram:     base58ToBytes32(ids.CCTP_V2_TOKEN_MESSENGER),
    cctpMessageTransmitterProgram: base58ToBytes32(ids.CCTP_V2_MESSAGE_TRANSMITTER),
    wormholeCoreProgram:         base58ToBytes32(ids.WORMHOLE_CORE),
    clockSysvar: base58ToBytes32("SysvarC1ock11111111111111111111111111111111"),
    rentSysvar:  base58ToBytes32("SysvarRent111111111111111111111111111111111"),
  };
}

/// Derives all Solana PDAs required for the RomeBridgeWithdraw constructor.
/// The USDC mint is passed in by the caller — never read from a global default —
/// so the same script works across any Rome chain. Only mint-independent
/// Wormhole accounts are needed: custody and wrapped_meta are derived per asset
/// on chain.
function loadSolanaPdas(usdcMintBase58: string, networkName: string) {
  const usdcMint = new PublicKey(usdcMintBase58);
  const ids = programIdsFor(networkName);
  const { cctpDomains: _d, cctpRemoteTokenMessengers: _r, ...cctp } = deriveCctpAccounts(usdcMint);
  return {
    ...cctp,
    ...deriveWormholeGlobalAccounts({
      tokenBridgeProgramId: ids.WORMHOLE_TOKEN_BRIDGE,
      coreProgramId:        ids.WORMHOLE_CORE,
    }),
  };
}

export interface WithdrawCtorInput {
  /** Rome network name: picks devnet or mainnet-beta Solana program ids. */
  networkName: string;
  /** The SPL_ERC20 wrapper of USDC on this chain. */
  usdcWrapper: `0x${string}`;
  /** Base58 mint of that wrapper. */
  usdcMintBase58: string;
  /** Admin: set in the constructor (no hand-over). */
  owner: `0x${string}`;
  /** Stop-only key, or the zero address for none. */
  guardian: `0x${string}`;
}

/**
 * The six constructor arguments of RomeBridgeWithdraw 13.x, in order:
 * (forwarder, usdc, cctp, wormhole, wormholeGeneric, guardian).
 *
 * forwarder = address(0): the meta-tx paymaster was removed (the constructor
 * refuses any other). Nothing is switched on at deploy time: no CCTP domain
 * (the owner runs enableCctpDomain afterwards) and no Wormhole chain or asset
 * (the owner runs the allowlist setters). Empty lists keep both rails fail-closed.
 * Owner and guardian are fixed here, so there is no hand-over gap.
 */
export function buildWithdrawConstructorArgs(i: WithdrawCtorInput) {
  const pdas = loadSolanaPdas(i.usdcMintBase58, i.networkName);
  const UNIVERSAL = universalFor(i.networkName);

  const cctpParams = {
    tokenMessengerProgram:     UNIVERSAL.cctpTokenMessengerProgram,
    messageTransmitterProgram: UNIVERSAL.cctpMessageTransmitterProgram,
    splTokenProgram:           UNIVERSAL.splTokenProgram,
    systemProgram:             UNIVERSAL.systemProgram,
    messageTransmitterConfig:  pdas.cctpMessageTransmitterConfig,
    tokenMessengerConfig:      pdas.cctpTokenMessengerConfig,
    tokenMinter:               pdas.cctpTokenMinter,
    localTokenUsdc:            pdas.cctpLocalTokenUsdc,
    senderAuthorityPda:        pdas.cctpSenderAuthorityPda,
    eventAuthority:            pdas.cctpEventAuthority,
    messageTransmitterEventAuthority: pdas.cctpMessageTransmitterEventAuthority,
  };

  const wormholeParams = {
    tokenBridgeProgram: UNIVERSAL.wormholeTokenBridgeProgram,
    coreProgram:        UNIVERSAL.wormholeCoreProgram,
    splTokenProgram:    UNIVERSAL.splTokenProgram,
    systemProgram:      UNIVERSAL.systemProgram,
    clockSysvar:        UNIVERSAL.clockSysvar,
    rentSysvar:         UNIVERSAL.rentSysvar,
    config:             pdas.wormholeConfig,
    authoritySigner:    pdas.wormholeAuthoritySigner,
    custodySigner:      pdas.wormholeCustodySigner,
    bridgeConfig:       pdas.wormholeBridgeConfig,
    feeCollector:       pdas.wormholeFeeCollector,
    emitter:            pdas.wormholeEmitter,
    sequence:           pdas.wormholeSequence,
  };

  const wormholeGeneric = { admin: i.owner, targetChains: [] as number[], assetWrappers: [] as `0x${string}`[] };

  return [ZERO_ADDRESS, i.usdcWrapper, cctpParams, wormholeParams, wormholeGeneric, i.guardian] as const;
}
