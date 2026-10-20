// scripts/bridge/deploy.ts
//
// Per-chain deploy script for the Rome Bridge stack:
//   - ERC20Users (idempotent — reused if already deployed)
//   - RomeBridgeWithdraw 13.0.0 (needs the USDC wrapper; skipped without USDC_MINT)
//
// The legacy RomeBridgePaymaster / RomeBridgeInbound were removed — the active
// flow is user-paid (burnUSDC / burnToWormhole / bridgeOutToSolana signed directly
// from the user's wallet) and inbound is settle_inbound_bridge on the Rome EVM program.
//
// v13 deploys with NO CCTP destination and NO Wormhole allowlist entries: both
// are switched on afterwards by the owner (scripts/bridge/enable-cctp-domains.ts,
// scripts/bridge/set-wormhole-allowlist.ts). The owner and guardian are set here.
//
//   BRIDGE_OWNER     owner address (admin). Defaults to WORMHOLE_ADMIN, then the deployer.
//   BRIDGE_GUARDIAN  stop-only ops key (pause, disable a domain). Defaults to none
//                    (zero address). Must differ from the owner.
//
// TESTNETS ONLY. This script refuses to send unless the RPC reports a listed testnet
// chain id (lib/testnet-guard.ts), so it cannot deploy on Rubicon. A Rubicon deploy of
// 13.0.0 does not exist in this repo yet: it is a separate follow-up PR (a Ledger-signed
// deploy with owner = the cold Ledger, guardian = the ops key, domains [0], empty
// Wormhole lists) and is required before the Rubicon step.
//
// Mint configuration is per-chain via env vars; constants no longer hard-code
// Rome's mints. Operators always pass the USDC mint explicitly:
//
//   USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU \
//   npx hardhat run scripts/bridge/deploy.ts --network <chain>
//
// Universal Solana constants (program IDs, sysvars) are base58-decoded here.
//
// CPI precompile address: 0xFF00000000000000000000000000000000000008
// (confirmed from contracts/interface.sol: `cpi_program_address`)

import { PublicKey } from "@solana/web3.js";
import hardhat from "hardhat";
import { readDeployments, writeDeployments } from "../lib/deployments.js";
import { SOLANA_DEVNET_NETWORKS } from "./lib/wormhole-target-chain.js";
import { base58ToBytes32 } from "../lib/pubkey.js";
import { SOLANA_PROGRAM_IDS, SOLANA_PROGRAM_IDS_DEVNET } from "./constants.js";
import { deriveCctpAccounts } from "./derive/cctp-accounts.js";
import { resolveRoles } from "./lib/deploy-roles.js";
import { assertTestnetSend } from "./lib/testnet-guard.js";
import { deriveWormholeGlobalAccounts } from "./derive/wormhole-accounts.js";

// CPI precompile at 0xff..08 as defined in contracts/interface.sol.
const CPI_PROGRAM_ADDRESS = "0xFF00000000000000000000000000000000000008" as const;

// Networks on Solana DEVNET use the devnet Wormhole/CCTP program ids AND bridge
// to Sepolia; the ONE set lives in lib/wormhole-target-chain.ts so the two can
// never disagree again (Martius/Nerva shipped with Ethereum as target).

function programIdsFor(networkName: string) {
  return SOLANA_DEVNET_NETWORKS.has(networkName)
    ? SOLANA_PROGRAM_IDS_DEVNET
    : SOLANA_PROGRAM_IDS;
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

// -------------------------------------------------------------------------
// Solana PDA account interface (deployment-specific; derived from chain mints)
// -------------------------------------------------------------------------

interface SolanaPdaAccounts {
  // CCTP PDAs
  cctpMessageTransmitterConfig: `0x${string}`;
  cctpTokenMessengerConfig:     `0x${string}`;
  cctpTokenMinter:              `0x${string}`;
  cctpLocalTokenUsdc:           `0x${string}`;
  cctpSenderAuthorityPda:       `0x${string}`;
  cctpEventAuthority:           `0x${string}`;
  cctpMessageTransmitterEventAuthority: `0x${string}`;
  // Wormhole PDAs
  wormholeConfig:          `0x${string}`;
  wormholeAuthoritySigner: `0x${string}`;
  wormholeCustodySigner:   `0x${string}`;
  wormholeBridgeConfig:    `0x${string}`;
  wormholeFeeCollector:    `0x${string}`;
  wormholeEmitter:         `0x${string}`;
  wormholeSequence:        `0x${string}`;
}

/// Derives all Solana PDAs required for the RomeBridgeWithdraw constructor.
/// The USDC mint is passed in by the caller — never read from a global default —
/// so the same script works across any Rome chain. The `networkName` selects
/// which Wormhole program IDs to derive sub-PDAs against (mainnet vs devnet).
/// CCTP uses the same IDs across clusters so its derivation is unaffected.
/// Only mint-independent Wormhole accounts are needed: custody and wrapped_meta
/// are derived per asset on chain.
function loadSolanaPdas(usdcMintBase58: string, networkName: string): SolanaPdaAccounts {
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

// -------------------------------------------------------------------------
// Deployment functions (exported for use in setup-local.ts)
// -------------------------------------------------------------------------

export async function ensureErc20Users(): Promise<`0x${string}`> {
  const { viem, networkName } = await hardhat.network.connect();
  // Fail closed on the RPC's real chain id, before anything is sent (see lib/testnet-guard.ts).
  await assertTestnetSend(await viem.getPublicClient(), `${networkName} deploy ERC20Users`);
  const d = readDeployments(networkName) as Record<string, any>;
  if (d["ERC20Users"]?.address) {
    console.log(`[${networkName}] ERC20Users already deployed at ${d["ERC20Users"].address}`);
    return d["ERC20Users"].address as `0x${string}`;
  }
  const users = await viem.deployContract("ERC20Users", []);
  const d2 = readDeployments(networkName) as Record<string, any>;
  d2["ERC20Users"] = { address: users.address };
  writeDeployments(networkName, d2 as any);
  console.log(`[${networkName}] ERC20Users → ${users.address}`);
  return users.address as `0x${string}`;
}

// Forward-only: wrappers are ALWAYS created via `bootstrap-bridged-wrappers.ts`
// (which calls `ERC20SPLFactory.add_spl_token_no_metadata` and emits the
// `TokenCreated` event the the Rome app backend indexer subscribes to). This
// helper reads the resulting addresses out of `deployments/<network>.json`
// and hard-fails if missing — there is intentionally no fallback to a
// direct `new SPL_ERC20(...)` deploy because that path would create a
// duplicate wrapper invisible to the indexer (the historic "throwaway
// wrapper" footgun from the pre-2026-05-18 deploy.ts).
function requireExistingWrapper(
  networkName: string,
  key: "SPL_ERC20_USDC",
  symbol: string,
): { address: `0x${string}` } {
  const existing = (readDeployments(networkName) as Record<string, any>)?.[key]?.address;
  if (!existing) {
    throw new Error(
      `[${networkName}] ${key} missing from deployments.json. ` +
      `Run scripts/bridge/bootstrap-bridged-wrappers.ts first ` +
      `(deploys canonical wrapper via factory, fires TokenCreated event).`,
    );
  }
  console.log(`[${networkName}] reusing ${symbol} wrapper at ${existing}`);
  return { address: existing as `0x${string}` };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

function envAddress(name: string): `0x${string}` | undefined {
  const v = (process.env[name] ?? "").trim();
  if (!v) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} is not a 20-byte 0x address`);
  return v as `0x${string}`;
}

export async function deployWithdraw(
  usdcWrapper: `0x${string}`,
  usdcMintBase58: string,
) {
  const { viem, networkName } = await hardhat.network.connect();
  // This script never deploys to mainnet: it refuses unless the RPC reports a
  // testnet chain id (lib/testnet-guard.ts). A Rubicon deploy is a separate follow-up
  // PR (Ledger-signed); there is no mainnet path in this file.
  await assertTestnetSend(await viem.getPublicClient(), `${networkName} deploy RomeBridgeWithdraw`);
  const pdas = loadSolanaPdas(usdcMintBase58, networkName);
  const UNIVERSAL = universalFor(networkName);

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

  // forwarder = address(0): the meta-tx paymaster was removed. ERC2771Context
  // with a zero forwarder resolves _msgSender() to msg.sender directly — the
  // user-paid flow the Rome app actually uses (burnUSDC / burnToWormhole /
  // bridgeOutToSolana are signed straight from the user's wallet, never sponsored).
  //
  // Nothing is switched on at deploy time: no CCTP domain (the owner runs
  // enable-cctp-domains.ts afterwards) and no Wormhole chain or asset (the owner
  // runs set-wormhole-allowlist.ts). Empty lists keep both rails fail-closed.
  //
  // Owner and guardian are fixed in the constructor, so there is no hand-over gap.
  const [deployerWallet] = await viem.getWalletClients();
  // Owner and guardian rules live in lib/deploy-roles.ts (tested): BRIDGE_OWNER, then
  // WORMHOLE_ADMIN, then the deployer; the guardian must differ from the owner.
  const deployerAddress = deployerWallet.account.address as `0x${string}`;
  const roles = resolveRoles({
    network: networkName,
    deployer: deployerAddress,
    bridgeOwner: envAddress("BRIDGE_OWNER"),
    wormholeAdmin: envAddress("WORMHOLE_ADMIN"),
    bridgeGuardian: envAddress("BRIDGE_GUARDIAN"),
  });
  const bridgeOwner = roles.owner as `0x${string}`;
  const bridgeGuardian = roles.guardian as `0x${string}`;
  console.log(`[${networkName}] owner → ${bridgeOwner}; guardian → ${bridgeGuardian === ZERO_ADDRESS ? "(none)" : bridgeGuardian}`);
  const wormholeGeneric = { admin: bridgeOwner, targetChains: [] as number[], assetWrappers: [] as `0x${string}`[] };

  const withdraw = await viem.deployContract("RomeBridgeWithdraw", [
    ZERO_ADDRESS,
    usdcWrapper,
    cctpParams,
    wormholeParams,
    wormholeGeneric,
    bridgeGuardian,
  ]);

  console.log(`[${networkName}] RomeBridgeWithdraw → ${withdraw.address}`);

  // Read everything back before it is recorded: a wrong constructor argument
  // (an owner that cannot be zeroed) must stop here, not after the registry
  // has been told about this address.
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const got = {
    version: (await withdraw.read.VERSION()) as string,
    owner: (await withdraw.read.owner()) as string,
    guardian: (await withdraw.read.guardian()) as string,
    domains: (await withdraw.read.cctpDomains()) as readonly number[],
  };
  if (got.version !== "13.0.0") throw new Error(`[${networkName}] VERSION() is ${got.version}, expected 13.0.0`);
  if (!same(got.owner, bridgeOwner)) throw new Error(`[${networkName}] owner() is ${got.owner}, expected ${bridgeOwner}`);
  if (!same(got.guardian, bridgeGuardian)) throw new Error(`[${networkName}] guardian() is ${got.guardian}, expected ${bridgeGuardian}`);
  if (got.domains.length !== 0) throw new Error(`[${networkName}] cctpDomains() is not empty: ${got.domains.join(",")}`);
  console.log(`[${networkName}] read back: VERSION ${got.version}, owner ${got.owner}, guardian ${got.guardian}, no CCTP domain enabled`);
  const d = readDeployments(networkName) as Record<string, any>;
  d["RomeBridgeWithdraw"] = { address: withdraw.address, deployedAt: Math.floor(Date.now() / 1000) };
  writeDeployments(networkName, d as any);

  return withdraw;
}

// -------------------------------------------------------------------------
// Standalone entrypoint
// -------------------------------------------------------------------------

/// Reads `USDC_MINT` from the environment. When it is absent, RomeBridgeWithdraw
/// is skipped.
function readMintEnv(): { usdcMint: string | null } {
  const usdc = (process.env.USDC_MINT ?? "").trim();
  return { usdcMint: usdc.length > 0 ? usdc : null };
}

async function main() {
  const { networkName } = await hardhat.network.connect();

  const { usdcMint } = readMintEnv();
  console.log(`[${networkName}] USDC_MINT=${usdcMint ?? "(unset — RomeBridgeWithdraw skipped)"}`);

  const usdc = usdcMint ? requireExistingWrapper(networkName, "SPL_ERC20_USDC", "wUSDC") : null;

  if (usdc && usdcMint) {
    await deployWithdraw(usdc.address, usdcMint);
    console.log(
      `[${networkName}] No CCTP domain is enabled yet. Next: ` +
      `npx tsx scripts/bridge/enable-cctp-domains.ts --network ${networkName} --domains <list>`,
    );
  } else {
    console.log(
      `[${networkName}] Skipping RomeBridgeWithdraw — USDC_MINT must be set to derive the CCTP PDAs ` +
      `and wire the constructor.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
