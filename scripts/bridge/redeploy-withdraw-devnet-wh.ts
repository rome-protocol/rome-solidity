// Redeploys RomeBridgeWithdraw using Solana *devnet* Wormhole program IDs
// and devnet-derived Wormhole PDAs. CCTP params stay on the shared mainnet
// program IDs (CCTP has a single program on both mainnet and devnet).
//
// Reuses the existing Paymaster + SPL_ERC20 wrapper addresses recorded in
// deployments/{network}.json so the ATA and rUSDC/rETH balances are preserved.

import hardhat from "hardhat";
import { readDeployments, writeDeployments } from "../lib/deployments.js";
import { base58ToBytes32 } from "../lib/pubkey.js";
import {
  SOLANA_PROGRAM_IDS,
  SOLANA_PROGRAM_IDS_DEVNET,
  SPL_MINTS,
} from "./constants.js";
import { deriveCctpAccounts } from "./derive/cctp-accounts.js";
import { deriveWormholeAccounts } from "./derive/wormhole-accounts.js";
import { PublicKey } from "@solana/web3.js";
import { keccak256, toUtf8Bytes } from "ethers";

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [admin] = await viem.getWalletClients();
  const d = readDeployments(networkName) as Record<string, any>;

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
  console.log("Wormhole program IDs (devnet):");
  console.log(`  Token Bridge: ${SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_TOKEN_BRIDGE}`);
  console.log(`  Core:         ${SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_CORE}`);

  const UNIVERSAL = {
    splTokenProgram:               base58ToBytes32(SOLANA_PROGRAM_IDS.SPL_TOKEN),
    systemProgram:                 base58ToBytes32(SOLANA_PROGRAM_IDS.SYSTEM_PROGRAM),
    cctpTokenMessengerProgram:     base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_TOKEN_MESSENGER),
    cctpMessageTransmitterProgram: base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_MESSAGE_TRANSMITTER),
    // Devnet Wormhole program IDs
    wormholeTokenBridgeProgram:    base58ToBytes32(SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_TOKEN_BRIDGE),
    wormholeCoreProgram:           base58ToBytes32(SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_CORE),
    clockSysvar: base58ToBytes32("SysvarC1ock11111111111111111111111111111111"),
    rentSysvar:  base58ToBytes32("SysvarRent111111111111111111111111111111111"),
  };

  const usdcMint = new PublicKey(SPL_MINTS.USDC_NATIVE);
  const wethMint = new PublicKey(SPL_MINTS.WETH_WORMHOLE);
  const pdas = {
    ...deriveCctpAccounts(usdcMint),
    ...deriveWormholeAccounts(wethMint, {
      tokenBridgeProgramId: SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_TOKEN_BRIDGE,
      coreProgramId: SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_CORE,
    }),
  };
  console.log("Derived Wormhole PDAs:");
  for (const [k, v] of Object.entries(pdas)) {
    if (k.startsWith("wormhole")) console.log(`  ${k.padEnd(24)} ${v}`);
  }

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
    targetChain:        10002, // Wormhole testnet chain id for Sepolia
  };

  console.log("\nDeploying new RomeBridgeWithdraw with devnet Wormhole params…");
  const withdraw = await viem.deployContract("RomeBridgeWithdraw", [
    paymaster, usdcAddr, wethAddr, cctpParams, wormholeParams,
  ]);
  console.log(`  RomeBridgeWithdraw → ${withdraw.address}`);

  d["RomeBridgeWithdraw"] = { address: withdraw.address, deployedAt: Math.floor(Date.now() / 1000) };
  writeDeployments(networkName, d as any);

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
