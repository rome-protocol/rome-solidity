// Redeploys SPL_ERC20 rETH with the canonical Wormhole wrapped-ETH mint, then
// redeploys RomeBridgeWithdraw wiring the new rETH. Reuses existing Paymaster
// + rUSDC. Re-registers paymaster allowlist for the new withdraw address.
//
// Pre-req: scripts/bridge/resolve-canonical-weth.ts passes against marcus's
// Solana RPC (mint exists on-chain).

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
import { deriveCanonicalWrappedMint } from "./lib/canonical-mint.js";
import { verifyMintOnChain } from "./lib/verify-mint-on-chain.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { keccak256, toUtf8Bytes } from "ethers";

const CPI_PROGRAM_ADDRESS = "0xFF00000000000000000000000000000000000008" as const;
const SEPOLIA_WETH_TOKEN_CHAIN = 10002;
const SEPOLIA_WETH_TOKEN_ADDR  = "eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c";

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [admin] = await viem.getWalletClients();
  const d = readDeployments(networkName) as Record<string, any>;

  const paymaster = d["RomeBridgePaymaster"]?.address;
  const usersAddr = d["ERC20Users"]?.address;
  const rusdcAddr = d["SPL_ERC20_USDC"]?.address;
  if (!paymaster || !usersAddr || !rusdcAddr) {
    throw new Error("Paymaster / ERC20Users / rUSDC missing — deploy those first.");
  }

  // Derive + verify canonical wrapped-ETH mint
  const canonicalWethMint = deriveCanonicalWrappedMint({
    tokenChain: SEPOLIA_WETH_TOKEN_CHAIN,
    tokenAddressHex: SEPOLIA_WETH_TOKEN_ADDR,
    tokenBridgeProgramId: SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_TOKEN_BRIDGE,
  });
  console.log(`Canonical wrapped-ETH mint: ${canonicalWethMint.toBase58()}`);
  const solanaRpc = "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz";
  const conn = new Connection(solanaRpc, "confirmed");
  await verifyMintOnChain(conn, canonicalWethMint.toBase58());
  console.log("  verified on-chain ✓");

  // Deploy new SPL_ERC20 for wETH with canonical mint
  const wrappedMintBytes32 = base58ToBytes32(canonicalWethMint.toBase58());
  const newReth = await viem.deployContract("SPL_ERC20", [
    wrappedMintBytes32,
    CPI_PROGRAM_ADDRESS,
    "Rome wETH (canonical)",
    "rETH",
    usersAddr,
  ]);
  console.log(`New SPL_ERC20 rETH (canonical mint): ${newReth.address}`);

  // Build CCTP + Wormhole params (same as redeploy-withdraw-devnet-wh.ts)
  const UNIVERSAL = {
    splTokenProgram:               base58ToBytes32(SOLANA_PROGRAM_IDS.SPL_TOKEN),
    systemProgram:                 base58ToBytes32(SOLANA_PROGRAM_IDS.SYSTEM_PROGRAM),
    cctpTokenMessengerProgram:     base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_TOKEN_MESSENGER),
    cctpMessageTransmitterProgram: base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_MESSAGE_TRANSMITTER),
    wormholeTokenBridgeProgram:    base58ToBytes32(SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_TOKEN_BRIDGE),
    wormholeCoreProgram:           base58ToBytes32(SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_CORE),
    clockSysvar: base58ToBytes32("SysvarC1ock11111111111111111111111111111111"),
    rentSysvar:  base58ToBytes32("SysvarRent111111111111111111111111111111111"),
  };

  const usdcMint = new PublicKey(SPL_MINTS.USDC_NATIVE);
  const pdas = {
    ...deriveCctpAccounts(usdcMint),
    ...deriveWormholeAccounts(canonicalWethMint, {
      tokenBridgeProgramId: SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_TOKEN_BRIDGE,
      coreProgramId: SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_CORE,
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
  };

  const withdraw = await viem.deployContract("RomeBridgeWithdraw", [
    paymaster, rusdcAddr, newReth.address, cctpParams, wormholeParams,
  ]);
  console.log(`New RomeBridgeWithdraw: ${withdraw.address}`);

  // Record new addresses
  d["SPL_ERC20_WETH"] = { address: newReth.address, mintId: canonicalWethMint.toBase58() };
  d["RomeBridgeWithdraw"] = { address: withdraw.address, deployedAt: Math.floor(Date.now() / 1000) };
  writeDeployments(networkName, d as any);

  // Re-register paymaster allowlist
  const paymasterC = await viem.getContractAt("RomeBridgePaymaster", paymaster);
  const burnUsdcSel = ("0x" + keccak256(toUtf8Bytes("burnUSDC(uint256,address)")).slice(2, 10)) as `0x${string}`;
  const burnEthSel  = ("0x" + keccak256(toUtf8Bytes("burnETH(uint256,address)")).slice(2, 10))  as `0x${string}`;
  await paymasterC.write.setAllowlistEntry([withdraw.address, burnUsdcSel, true]);
  await paymasterC.write.setAllowlistEntry([withdraw.address, burnEthSel, true]);
  console.log("Paymaster allowlist updated for new withdraw.");

  console.log("\n✓ Redeploy complete. Addresses:");
  console.log(`  SPL_ERC20_WETH (rETH, canonical): ${newReth.address}`);
  console.log(`  RomeBridgeWithdraw:               ${withdraw.address}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
