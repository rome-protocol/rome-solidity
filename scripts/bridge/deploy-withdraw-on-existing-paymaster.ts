// One-off: deploy a fresh RomeBridgeWithdraw against an EXISTING paymaster
// + the factory-deployed WUSDC/WETH wrappers recorded in deployments.json.
//
// Usage: npx hardhat run scripts/bridge/deploy-withdraw-on-existing-paymaster.ts --network <chain>
//
// Reuses deployments.json keys: RomeBridgePaymaster, SPL_ERC20_USDC, SPL_ERC20_WETH.
//
// Sends as legacy (type-0) tx — Rome's rome-proxy doesn't parse EIP-1559
// (type-2) tx fields and rejects with `-32000 missing or invalid parameters`,
// so we bypass viem.deployContract's default type-2 path and submit raw.

import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { keccak256, toUtf8Bytes } from "ethers";
import hardhat from "hardhat";
import { encodeDeployData, encodeFunctionData, parseGwei } from "viem";
import { readDeployments, writeDeployments } from "../lib/deployments.js";
import { base58ToBytes32 } from "../lib/pubkey.js";
import { SOLANA_PROGRAM_IDS, SOLANA_PROGRAM_IDS_DEVNET, SPL_MINTS_DEVNET } from "./constants.js";
import { deriveCctpAccounts } from "./derive/cctp-accounts.js";
import { deriveWormholeAccounts } from "./derive/wormhole-accounts.js";

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [walletClient] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const d = readDeployments(networkName) as Record<string, any>;

  const paymaster = d["RomeBridgePaymaster"]?.address as `0x${string}` | undefined;
  const usdc = d["SPL_ERC20_USDC"]?.address as `0x${string}` | undefined;
  const weth = d["SPL_ERC20_WETH"]?.address as `0x${string}` | undefined;
  if (!paymaster) throw new Error("RomeBridgePaymaster missing from deployments.json");
  if (!usdc) throw new Error("SPL_ERC20_USDC missing — run bootstrap-bridged-wrappers first");
  if (!weth) throw new Error("SPL_ERC20_WETH missing — run bootstrap-bridged-wrappers first");

  console.log(`[${networkName}] reusing:`);
  console.log(`  RomeBridgePaymaster: ${paymaster}`);
  console.log(`  SPL_ERC20_USDC:      ${usdc}`);
  console.log(`  SPL_ERC20_WETH:      ${weth}`);

  // Devnet-targeted programs + Sepolia Wormhole chain id (10002).
  const UNIVERSAL = {
    splTokenProgram:               base58ToBytes32(SOLANA_PROGRAM_IDS.SPL_TOKEN),
    systemProgram:                 base58ToBytes32(SOLANA_PROGRAM_IDS.SYSTEM_PROGRAM),
    cctpTokenMessengerProgram:     base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_TOKEN_MESSENGER),
    cctpMessageTransmitterProgram: base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_MESSAGE_TRANSMITTER),
    wormholeTokenBridgeProgram:    base58ToBytes32(SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_TOKEN_BRIDGE),
    wormholeCoreProgram:           base58ToBytes32(SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_CORE),
    clockSysvar:                   base58ToBytes32("SysvarC1ock11111111111111111111111111111111"),
    rentSysvar:                    base58ToBytes32("SysvarRent111111111111111111111111111111111"),
  };

  const usdcMint = new PublicKey(SPL_MINTS_DEVNET.USDC_NATIVE);
  const wethMint = new PublicKey(SPL_MINTS_DEVNET.WETH_WORMHOLE);
  const pdas = {
    ...deriveCctpAccounts(usdcMint),
    ...deriveWormholeAccounts(wethMint, {
      tokenBridgeProgramId: SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_TOKEN_BRIDGE,
      coreProgramId:        SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_CORE,
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
    targetChain:        10002, // Sepolia Wormhole chain id
  };

  // Load the compiled artifact directly so we can submit a raw legacy tx.
  const artifactPath = path.resolve("artifacts/contracts/bridge/RomeBridgeWithdraw.sol/RomeBridgeWithdraw.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as { abi: any; bytecode: `0x${string}` };

  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [paymaster, usdc, weth, cctpParams, wormholeParams],
  });

  console.log(`\nDeploying RomeBridgeWithdraw (legacy tx, ${data.length / 2 - 1} bytes data)…`);
  const hash = await walletClient.sendTransaction({
    data,
    type: "legacy",
    gas: 150_000_000n,
    gasPrice: parseGwei("100"),
  });
  console.log(`  tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    throw new Error(`deploy succeeded but receipt has no contractAddress (status=${receipt.status})`);
  }
  const withdrawAddress = receipt.contractAddress;
  console.log(`  RomeBridgeWithdraw → ${withdrawAddress}`);

  const d2 = readDeployments(networkName) as Record<string, any>;
  d2["RomeBridgeWithdraw"] = { address: withdrawAddress, deployedAt: Math.floor(Date.now() / 1000) };
  writeDeployments(networkName, d2 as any);

  // Allowlist new burn selectors on existing paymaster (also via legacy tx).
  const burnUsdcSel = ("0x" + keccak256(toUtf8Bytes("burnUSDC(uint256,address)")).slice(2, 10)) as `0x${string}`;
  const burnEthSel  = ("0x" + keccak256(toUtf8Bytes("burnETH(uint256,address)")).slice(2, 10))  as `0x${string}`;

  for (const [label, sel] of [["burnUSDC", burnUsdcSel], ["burnETH", burnEthSel]] as const) {
    const allowlistData = encodeFunctionData({
      abi: [{
        type: "function",
        name: "setAllowlistEntry",
        inputs: [
          { name: "target", type: "address" },
          { name: "selector", type: "bytes4" },
          { name: "allowed", type: "bool" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
      }],
      functionName: "setAllowlistEntry",
      args: [withdrawAddress, sel, true],
    });
    const txHash = await walletClient.sendTransaction({
      to: paymaster,
      data: allowlistData,
      type: "legacy",
      gas: 1_000_000n,
      gasPrice: parseGwei("100"),
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`  Allowlisted ${label} (sel ${sel}) on paymaster — tx ${txHash}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
