// Redeploys only RomeBridgeWithdraw (new 17-account CCTP layout) against the
// existing Paymaster + SPL_ERC20 wrapper addresses already recorded in
// deployments/{network}.json. Preserves the deployer's cached ATA + USDC balance.

import hardhat from "hardhat";
import { readDeployments, writeDeployments } from "../lib/deployments.js";
import { base58ToBytes32 } from "../lib/pubkey.js";
import { SOLANA_PROGRAM_IDS, SOLANA_PROGRAM_IDS_DEVNET, SPL_MINTS } from "./constants.js";
import { deriveCctpAccounts } from "./derive/cctp-accounts.js";
import { deriveWormholeAccounts } from "./derive/wormhole-accounts.js";
import { PublicKey } from "@solana/web3.js";
import { keccak256, toUtf8Bytes } from "ethers";

// Network classification: chains targeting Solana devnet (Wormhole devnet IDs
// + bridge to Sepolia) vs mainnet. Marcus, cassius, all current Rome chains
// run against Solana devnet — only future production chains would use mainnet.
const SOLANA_DEVNET_NETWORKS = new Set(["marcus", "cassius", "subura", "esquiline", "aventine", "maximus", "local"]);

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [admin] = await viem.getWalletClients();
  const d = readDeployments(networkName) as Record<string, any>;
  const isDevnet = SOLANA_DEVNET_NETWORKS.has(networkName);
  const PROGRAM_IDS = isDevnet ? SOLANA_PROGRAM_IDS_DEVNET : SOLANA_PROGRAM_IDS;
  const targetWormholeChain = isDevnet ? 10002 : 2;
  console.log(`[${networkName}] Solana cluster: ${isDevnet ? "devnet" : "mainnet"}`);
  console.log(`  Wormhole TB:   ${PROGRAM_IDS.WORMHOLE_TOKEN_BRIDGE}`);
  console.log(`  Wormhole core: ${PROGRAM_IDS.WORMHOLE_CORE}`);
  console.log(`  CCTP TMM:      ${PROGRAM_IDS.CCTP_TOKEN_MESSENGER}`);
  console.log(`  Wormhole target chain id: ${targetWormholeChain} (${isDevnet ? "Sepolia" : "Mainnet"})`);

  const paymaster = d["RomeBridgePaymaster"]?.address;
  const usdcAddr  = d["SPL_ERC20_USDC"]?.address;
  const wethAddr  = d["SPL_ERC20_WETH"]?.address;
  if (!paymaster || !usdcAddr || !wethAddr) {
    throw new Error("Paymaster / USDC / wETH deployments missing — run full deploy first.");
  }
  console.log(`[${networkName}] reusing:`);
  console.log(`  RomeBridgePaymaster: ${paymaster}`);
  console.log(`  SPL_ERC20 rUSDC:     ${usdcAddr}`);
  console.log(`  SPL_ERC20 rETH:      ${wethAddr}`);

  const UNIVERSAL = {
    splTokenProgram:               base58ToBytes32(PROGRAM_IDS.SPL_TOKEN),
    systemProgram:                 base58ToBytes32(PROGRAM_IDS.SYSTEM_PROGRAM),
    wormholeTokenBridgeProgram:    base58ToBytes32(PROGRAM_IDS.WORMHOLE_TOKEN_BRIDGE),
    cctpTokenMessengerProgram:     base58ToBytes32(PROGRAM_IDS.CCTP_TOKEN_MESSENGER),
    cctpMessageTransmitterProgram: base58ToBytes32(PROGRAM_IDS.CCTP_MESSAGE_TRANSMITTER),
    wormholeCoreProgram:           base58ToBytes32(PROGRAM_IDS.WORMHOLE_CORE),
    clockSysvar: base58ToBytes32("SysvarC1ock11111111111111111111111111111111"),
    rentSysvar:  base58ToBytes32("SysvarRent111111111111111111111111111111111"),
  };

  const usdcMint = new PublicKey(SPL_MINTS.USDC_NATIVE);
  const wethMint = new PublicKey(SPL_MINTS.WETH_WORMHOLE);
  // CRITICAL: pass the cluster's actual program IDs to derive PDAs against the
  // RIGHT program. Without overrides, deriveWormholeAccounts defaults to
  // SOLANA_PROGRAM_IDS (mainnet) — its sub-PDAs (config, authority_signer,
  // emitter, wrapped_meta, bridge_config, fee_collector, sequence) would all
  // be derived against the mainnet Wormhole TB/Core IDs, not the devnet IDs
  // actually deployed on Marcus's Solana cluster. The contract's top-level
  // wormholeTokenBridgeProgram immutable would point at devnet but every
  // sub-PDA would point at mainnet's address — silent mismatch causing
  // Wormhole to revert with `Custom(0)`. CCTP uses the same program ID
  // across clusters so its derivation defaults are accidentally fine.
  const pdas = {
    ...deriveCctpAccounts(usdcMint),
    ...deriveWormholeAccounts(wethMint, {
      tokenBridgeProgramId: PROGRAM_IDS.WORMHOLE_TOKEN_BRIDGE,
      coreProgramId:        PROGRAM_IDS.WORMHOLE_CORE,
    }),
  };

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
    targetChain:        targetWormholeChain,
  };

  console.log("\nDeploying new RomeBridgeWithdraw (17-account CCTP layout)…");
  const withdraw = await viem.deployContract("RomeBridgeWithdraw", [
    paymaster, usdcAddr, wethAddr, cctpParams, wormholeParams,
  ]);
  console.log(`  RomeBridgeWithdraw → ${withdraw.address}`);

  // Record in deployments
  d["RomeBridgeWithdraw"] = { address: withdraw.address, deployedAt: Math.floor(Date.now() / 1000) };
  if (!d.archive) d.archive = {};
  d.archive.RomeBridgeWithdrawPrevious = d["RomeBridgeWithdraw_previous"] ?? null;
  writeDeployments(networkName, d as any);

  // Re-register burn selectors on paymaster allowlist against the new withdraw address.
  const paymasterC = await viem.getContractAt("RomeBridgePaymaster", paymaster);
  const burnUsdcSel = ("0x" + keccak256(toUtf8Bytes("burnUSDC(uint256,address)")).slice(2, 10)) as `0x${string}`;
  const burnEthSel  = ("0x" + keccak256(toUtf8Bytes("burnETH(uint256,address)")).slice(2, 10))  as `0x${string}`;
  await paymasterC.write.setAllowlistEntry([withdraw.address, burnUsdcSel, true]);
  await paymasterC.write.setAllowlistEntry([withdraw.address, burnEthSel, true]);
  console.log("  Allowlisted burnUSDC + burnETH on paymaster for new withdraw");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
