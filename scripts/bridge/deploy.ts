// scripts/bridge/deploy.ts
//
// Per-chain deploy script for the Rome Bridge stack:
//   - ERC20Users (idempotent — reused if already deployed)
//   - SPL_ERC20 wrappers for USDC (WUSDC) and wETH (WETH), one per env-var-supplied mint
//   - RomeBridgeWithdraw (only if both wrappers were deployed — otherwise skipped)
//
// The legacy RomeBridgePaymaster / RomeBridgeInbound were removed — the active
// flow is user-paid (burnUSDC / burnETH / bridgeOutToSolana signed directly from
// the user's wallet) and inbound is settle_inbound_bridge on rome-evm-private.
//
// Mint configuration is per-chain via env vars; constants no longer hard-code
// Rome's mints. Operators always pass the mints explicitly:
//
//   USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU \
//   WETH_MINT=6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs \
//   npx hardhat run scripts/bridge/deploy.ts --network <chain>
//
// If a mint env var is empty / unset, the corresponding SPL_ERC20 wrapper is
// skipped. RomeBridgeWithdraw deploys only when BOTH USDC + WETH wrappers are
// present, since its constructor takes both and per-mint Wormhole / CCTP PDAs
// must be derived from real mints. A chain with no Ethereum-origin bridge
// target therefore gets ERC20Users + wrappers only — no broken withdraw artefact.
//
// Universal Solana constants (program IDs, sysvars) are base58-decoded here.
//
// CPI precompile address: 0xFF00000000000000000000000000000000000008
// (confirmed from contracts/interface.sol: `cpi_program_address`)

import { PublicKey } from "@solana/web3.js";
import hardhat from "hardhat";
import { readDeployments, writeDeployments } from "../lib/deployments.js";
import { base58ToBytes32 } from "../lib/pubkey.js";
import { SOLANA_PROGRAM_IDS, SOLANA_PROGRAM_IDS_DEVNET } from "./constants.js";
import { deriveCctpAccounts } from "./derive/cctp-accounts.js";
import { deriveWormholeAccounts } from "./derive/wormhole-accounts.js";

// CPI precompile at 0xff..08 as defined in contracts/interface.sol.
const CPI_PROGRAM_ADDRESS = "0xFF00000000000000000000000000000000000008" as const;

// Networks that target Solana DEVNET (Wormhole devnet IDs + Sepolia destination).
// Mainnet networks use the canonical mainnet IDs. Wormhole's program IDs differ
// per cluster; CCTP's are the same on both. Update this set when bringing up a
// new chain — adding it here keeps the deploy + sub-PDA derivations consistent.
const SOLANA_DEVNET_NETWORKS = new Set([
  "marcus", "cassius", "subura", "esquiline", "aventine", "maximus", "local",
  "trajan", "hadrian",
]);

function programIdsFor(networkName: string) {
  return SOLANA_DEVNET_NETWORKS.has(networkName)
    ? SOLANA_PROGRAM_IDS_DEVNET
    : SOLANA_PROGRAM_IDS;
}

// Cluster-aware UNIVERSAL block. Wormhole Token Bridge / Core program IDs
// vary per cluster; CCTP and SPL Token / System Program are identical
// across clusters.
function universalFor(networkName: string) {
  const ids = programIdsFor(networkName);
  return {
    splTokenProgram:             base58ToBytes32(ids.SPL_TOKEN),
    systemProgram:               base58ToBytes32(ids.SYSTEM_PROGRAM),
    wormholeTokenBridgeProgram:  base58ToBytes32(ids.WORMHOLE_TOKEN_BRIDGE),
    cctpTokenMessengerProgram:   base58ToBytes32(ids.CCTP_TOKEN_MESSENGER),
    cctpMessageTransmitterProgram: base58ToBytes32(ids.CCTP_MESSAGE_TRANSMITTER),
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
  cctpRemoteTokenMessenger:     `0x${string}`;
  cctpTokenMinter:              `0x${string}`;
  cctpLocalTokenUsdc:           `0x${string}`;
  cctpSenderAuthorityPda:       `0x${string}`;
  cctpEventAuthority:           `0x${string}`;
  cctpMessageTransmitterEventAuthority: `0x${string}`;
  // Wormhole PDAs
  wormholeConfig:          `0x${string}`;
  wormholeCustody:         `0x${string}`;
  wormholeAuthoritySigner: `0x${string}`;
  wormholeCustodySigner:   `0x${string}`;
  wormholeBridgeConfig:    `0x${string}`;
  wormholeFeeCollector:    `0x${string}`;
  wormholeEmitter:         `0x${string}`;
  wormholeSequence:        `0x${string}`;
  wormholeWrappedMeta:     `0x${string}`;
}

/// Derives all Solana PDAs required for the RomeBridgeWithdraw constructor.
/// Both mints are passed in by the caller — never read from a global default —
/// so the same script works across any Rome chain. The `networkName` selects
/// which Wormhole program IDs to derive sub-PDAs against (mainnet vs devnet).
/// CCTP uses the same IDs across clusters so its derivation is unaffected.
function loadSolanaPdas(usdcMintBase58: string, wethMintBase58: string, networkName: string): SolanaPdaAccounts {
  const usdcMint = new PublicKey(usdcMintBase58);
  const wethMint = new PublicKey(wethMintBase58);
  const ids = programIdsFor(networkName);
  return {
    ...deriveCctpAccounts(usdcMint),
    ...deriveWormholeAccounts(wethMint, {
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
// `TokenCreated` event the rome-ui backend indexer subscribes to). This
// helper reads the resulting addresses out of `deployments/<network>.json`
// and hard-fails if missing — there is intentionally no fallback to a
// direct `new SPL_ERC20(...)` deploy because that path would create a
// duplicate wrapper invisible to the indexer (the historic "throwaway
// wrapper" footgun from the pre-2026-05-18 deploy.ts).
function requireExistingWrapper(
  networkName: string,
  key: "SPL_ERC20_USDC" | "SPL_ERC20_WETH",
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

export async function deployWithdraw(
  usdcWrapper: `0x${string}`,
  wethWrapper: `0x${string}`,
  usdcMintBase58: string,
  wethMintBase58: string,
) {
  const { viem, networkName } = await hardhat.network.connect();
  const pdas = loadSolanaPdas(usdcMintBase58, wethMintBase58, networkName);
  const UNIVERSAL = universalFor(networkName);

  const cctpParams = {
    tokenMessengerProgram:     UNIVERSAL.cctpTokenMessengerProgram,
    messageTransmitterProgram: UNIVERSAL.cctpMessageTransmitterProgram,
    splTokenProgram:           UNIVERSAL.splTokenProgram,
    systemProgram:             UNIVERSAL.systemProgram,
    messageTransmitterConfig:  pdas.cctpMessageTransmitterConfig,
    tokenMessengerConfig:      pdas.cctpTokenMessengerConfig,
    remoteTokenMessenger:      pdas.cctpRemoteTokenMessenger,
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
    custody:            pdas.wormholeCustody,
    authoritySigner:    pdas.wormholeAuthoritySigner,
    custodySigner:      pdas.wormholeCustodySigner,
    bridgeConfig:       pdas.wormholeBridgeConfig,
    feeCollector:       pdas.wormholeFeeCollector,
    emitter:            pdas.wormholeEmitter,
    sequence:           pdas.wormholeSequence,
    wrappedMeta:        pdas.wormholeWrappedMeta,
    // Wormhole destination chain id — 2 for Ethereum mainnet, 10002 for Sepolia.
    // All current Rome chains target Sepolia (devnet). When a mainnet Rome
    // chain is brought up, fold its networkName into the mainnet branch (or
    // replace this block with a `chain.bridge.sourceEvm.chainId` lookup from
    // the registry). The earlier `"<chain>"` placeholder was a leftover from
    // PR #97's marcus-sweep — it never matched any real network and silently
    // routed Marcus's outbound Wormhole to Ethereum mainnet.
    targetChain:        ["marcus", "local", "trajan", "hadrian"].includes(networkName) ? 10002 : 2,
  };

  // forwarder = address(0): the meta-tx paymaster was removed. ERC2771Context
  // with a zero forwarder resolves _msgSender() to msg.sender directly — the
  // user-paid flow rome-ui actually uses (burnUSDC / burnETH / bridgeOutToSolana
  // are signed straight from the user's wallet, never sponsored).
  const withdraw = await viem.deployContract("RomeBridgeWithdraw", [
    "0x0000000000000000000000000000000000000000",
    usdcWrapper,
    wethWrapper,
    cctpParams,
    wormholeParams,
  ]);

  console.log(`[${networkName}] RomeBridgeWithdraw → ${withdraw.address}`);
  const d = readDeployments(networkName) as Record<string, any>;
  d["RomeBridgeWithdraw"] = { address: withdraw.address, deployedAt: Math.floor(Date.now() / 1000) };
  writeDeployments(networkName, d as any);

  return withdraw;
}

// -------------------------------------------------------------------------
// Standalone entrypoint
// -------------------------------------------------------------------------

/// Reads `USDC_MINT` and `WETH_MINT` from the environment. Either may be
/// absent — the corresponding wrapper is skipped in that case, and
/// RomeBridgeWithdraw is skipped unless both are present.
function readMintEnv(): { usdcMint: string | null; wethMint: string | null } {
  const usdc = (process.env.USDC_MINT ?? "").trim();
  const weth = (process.env.WETH_MINT ?? "").trim();
  return {
    usdcMint: usdc.length > 0 ? usdc : null,
    wethMint: weth.length > 0 ? weth : null,
  };
}

async function main() {
  const { networkName } = await hardhat.network.connect();

  const { usdcMint, wethMint } = readMintEnv();
  console.log(
    `[${networkName}] USDC_MINT=${usdcMint ?? "(unset — WUSDC wrapper skipped)"}; ` +
    `WETH_MINT=${wethMint ?? "(unset — WETH wrapper skipped)"}`,
  );

  const usdc = usdcMint ? requireExistingWrapper(networkName, "SPL_ERC20_USDC", "wUSDC") : null;
  const weth = wethMint ? requireExistingWrapper(networkName, "SPL_ERC20_WETH", "wETH") : null;

  if (usdc && weth && usdcMint && wethMint) {
    await deployWithdraw(usdc.address, weth.address, usdcMint, wethMint);
  } else {
    console.log(
      `[${networkName}] Skipping RomeBridgeWithdraw — both USDC_MINT and WETH_MINT must be set ` +
      `to derive Wormhole/CCTP PDAs and wire the constructor. Deploy ERC20Users + wrappers only.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
