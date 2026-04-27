// scripts/bridge/deploy.ts
//
// Phase 1.4 deploy script for Rome Bridge contracts:
//   - RomeBridgePaymaster
//   - ERC20Users (if not already deployed)
//   - SPL_ERC20 wrappers for USDC (rUSDC) and wETH (rETH)
//   - RomeBridgeWithdraw (once Phase 1.5 supplies Solana PDAs)
//
// Universal Solana constants (program IDs, sysvars) are base58-decoded here.
// Per-deployment PDAs are stubbed with a Phase 1.5 TODO error — running this
// script against a live network will throw at that point. The compile/typecheck
// target for Phase 1.4 is met.
//
// CPI precompile address: 0xFF00000000000000000000000000000000000008
// (confirmed from contracts/interface.sol: `cpi_program_address`)

import { PublicKey } from "@solana/web3.js";
import hardhat from "hardhat";
import { readDeployments, writeDeployments } from "../lib/deployments.js";
import { base58ToBytes32 } from "../lib/pubkey.js";
import { SOLANA_PROGRAM_IDS, SPL_MINTS } from "./constants.js";
import { deriveCctpAccounts } from "./derive/cctp-accounts.js";
import { deriveWormholeAccounts } from "./derive/wormhole-accounts.js";

// CPI precompile at 0xff..08 as defined in contracts/interface.sol.
const CPI_PROGRAM_ADDRESS = "0xFF00000000000000000000000000000000000008" as const;

// Universal Solana constants — same across mainnet / devnet / local (network-invariant).
const UNIVERSAL = {
  splTokenProgram:             base58ToBytes32(SOLANA_PROGRAM_IDS.SPL_TOKEN),
  systemProgram:               base58ToBytes32(SOLANA_PROGRAM_IDS.SYSTEM_PROGRAM),
  wormholeTokenBridgeProgram:  base58ToBytes32(SOLANA_PROGRAM_IDS.WORMHOLE_TOKEN_BRIDGE),
  cctpTokenMessengerProgram:   base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_TOKEN_MESSENGER),
  cctpMessageTransmitterProgram: base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_MESSAGE_TRANSMITTER),
  wormholeCoreProgram:         base58ToBytes32(SOLANA_PROGRAM_IDS.WORMHOLE_CORE),
  // Sysvars — well-known fixed addresses on all Solana clusters.
  clockSysvar: base58ToBytes32("SysvarC1ock11111111111111111111111111111111"),
  rentSysvar:  base58ToBytes32("SysvarRent111111111111111111111111111111111"),
};

// -------------------------------------------------------------------------
// Solana PDA account interface (deployment-specific; derived in Phase 1.5)
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
/// Uses canonical mainnet program IDs from constants.ts — correct for local,
/// monti_spl (devnet), and mainnet as long as those programs are deployed at
/// the same addresses (rome-setup seeds them on local).
function loadSolanaPdas(_networkName: string): SolanaPdaAccounts {
  const usdcMint = new PublicKey(SPL_MINTS.USDC_NATIVE);
  const wethMint = new PublicKey(SPL_MINTS.WETH_WORMHOLE);
  return {
    ...deriveCctpAccounts(usdcMint),
    ...deriveWormholeAccounts(wethMint),
  };
}

// -------------------------------------------------------------------------
// Deployment functions (exported for use in setup-local.ts)
// -------------------------------------------------------------------------

export async function deployPaymaster(admin: `0x${string}`) {
  const { viem, networkName } = await hardhat.network.connect();
  const paymaster = await viem.deployContract("RomeBridgePaymaster", [admin]);
  console.log(`[${networkName}] RomeBridgePaymaster → ${paymaster.address}`);
  const d = readDeployments(networkName) as Record<string, any>;
  d["RomeBridgePaymaster"] = { address: paymaster.address, deployedAt: Math.floor(Date.now() / 1000) };
  writeDeployments(networkName, d as any);
  return paymaster;
}

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

export async function deploySplErc20(
  key: "SPL_ERC20_USDC" | "SPL_ERC20_WETH",
  name: string,
  symbol: string,
  mintBase58: string,
  cpiProgramAddress: `0x${string}`
) {
  const { viem, networkName } = await hardhat.network.connect();
  const usersAddr = await ensureErc20Users();
  const mintBytes32 = base58ToBytes32(mintBase58);
  const wrapper = await viem.deployContract("SPL_ERC20", [
    mintBytes32,
    cpiProgramAddress,
    name,
    symbol,
    usersAddr,
  ]);
  console.log(`[${networkName}] SPL_ERC20 ${symbol} → ${wrapper.address} (mint ${mintBase58})`);
  const d = readDeployments(networkName) as Record<string, any>;
  d[key] = { address: wrapper.address, mintId: mintBase58 };
  writeDeployments(networkName, d as any);
  return wrapper;
}

export async function deployWithdraw(
  paymasterAddress: `0x${string}`,
  usdcWrapper: `0x${string}`,
  wethWrapper: `0x${string}`
) {
  const { viem, networkName } = await hardhat.network.connect();
  // Phase 1.5 TODO: loadSolanaPdas() will throw here until PDA derivation is implemented.
  const pdas = loadSolanaPdas(networkName);

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
    // Pick based on the Ethereum-side target for this Rome deployment.
    targetChain:        networkName === "marcus" || networkName === "local" ? 10002 : 2,
  };

  const withdraw = await viem.deployContract("RomeBridgeWithdraw", [
    paymasterAddress,
    usdcWrapper,
    wethWrapper,
    cctpParams,
    wormholeParams,
  ]);

  console.log(`[${networkName}] RomeBridgeWithdraw → ${withdraw.address}`);
  const d = readDeployments(networkName) as Record<string, any>;
  d["RomeBridgeWithdraw"] = { address: withdraw.address, deployedAt: Math.floor(Date.now() / 1000) };
  writeDeployments(networkName, d as any);

  // Register burn selectors on paymaster allowlist.
  // Selector = first 4 bytes of keccak256(function signature).
  const { keccak256, toUtf8Bytes } = await import("ethers");
  const burnUsdcSelector = ("0x" + keccak256(toUtf8Bytes("burnUSDC(uint256,address)")).slice(2, 10)) as `0x${string}`;
  const burnEthSelector  = ("0x" + keccak256(toUtf8Bytes("burnETH(uint256,address)")).slice(2, 10))  as `0x${string}`;

  const paymasterC = await viem.getContractAt("RomeBridgePaymaster", paymasterAddress);
  await paymasterC.write.setAllowlistEntry([withdraw.address, burnUsdcSelector, true]);
  await paymasterC.write.setAllowlistEntry([withdraw.address, burnEthSelector, true]);
  console.log(`[${networkName}] Allowlisted burnUSDC + burnETH on paymaster`);

  return withdraw;
}

// -------------------------------------------------------------------------
// Standalone entrypoint
// -------------------------------------------------------------------------

async function main() {
  const { viem } = await hardhat.network.connect();
  const [admin] = await viem.getWalletClients();

  const paymaster = await deployPaymaster(admin.account!.address);
  const usdc = await deploySplErc20("SPL_ERC20_USDC", "Rome USDC", "rUSDC", SPL_MINTS.USDC_NATIVE, CPI_PROGRAM_ADDRESS);
  const weth = await deploySplErc20("SPL_ERC20_WETH", "Rome wETH", "rETH", SPL_MINTS.WETH_WORMHOLE, CPI_PROGRAM_ADDRESS);
  await deployWithdraw(paymaster.address, usdc.address, weth.address);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
