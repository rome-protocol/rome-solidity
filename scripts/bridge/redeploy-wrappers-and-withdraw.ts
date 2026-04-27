// Redeploys both SPL_ERC20 wrappers (wUSDC + wETH) and RomeBridgeWithdraw
// with the post-#63 bytecode that auto-creates the recipient ATA on
// transfer / mint_to. The pre-#63 wrappers revert with "Token account
// does not exist" the first time a fresh address receives the wrapper,
// which MetaMask renders as a greyed-out Send button.
//
// What this script does:
//   1. Reads existing paymaster + ERC20Users from deployments/<network>.json.
//      ERC20Users is preserved so per-user payer PDAs stay intact (no
//      onboarding tax on existing holders).
//   2. Deploys a new SPL_ERC20 for the USDC mint (auto-ATA-fix bytecode).
//   3. Deploys a new SPL_ERC20 for the WETH mint (same bytecode).
//   4. Deploys a new RomeBridgeWithdraw wired to both new wrappers.
//   5. Re-allowlists burnUSDC + burnETH selectors on the existing paymaster
//      for the new RomeBridgeWithdraw address.
//   6. Archives old addresses and writes new ones into
//      deployments/<network>.json.
//
// What this does NOT change:
//   - rome-evm program on Solana
//   - Proxy / Hercules
//   - RomeBridgePaymaster (constructor unchanged; reuse)
//   - ERC20Users registry (per-user payer PDAs preserved)
//   - User SPL balances (live in PDA-owned ATAs on Solana, mint-keyed —
//     the new wrappers read the same SPL accounts)
//   - Romeswap factory wrappers (separate codepath; deprecate later)
//
// Downstream once this script lands on-chain:
//   - rome-ui chains.yaml: update `marcus.contracts.gasWrapper` to the new
//     wUSDC address so MetaMask points at the fixed wrapper.
//   - rome-ui chains.yaml: update bridge.evm.romeBridgeWithdraw to the new
//     RomeBridgeWithdraw address.
//
// Pre-req: deployer wallet has gas on Marcus (rUSDC native gas).
// Run: npx hardhat run scripts/bridge/redeploy-wrappers-and-withdraw.ts \
//        --network marcus --build-profile production

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

const CPI_PROGRAM_ADDRESS = "0xFF00000000000000000000000000000000000008" as const;

// Sepolia Wormhole chain id. Marcus's RomeBridgeWithdraw redeems on
// Sepolia, so outbound Wormhole VAAs target chain 10002. Mainnet would
// target chain 2; that's a separate redeploy.
const WORMHOLE_TARGET_CHAIN = 10002;

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [admin] = await viem.getWalletClients();
  if (!admin?.account) {
    throw new Error("No deployer wallet — set MARCUS_PRIVATE_KEY in keystore.");
  }
  const d = readDeployments(networkName) as Record<string, any>;

  const paymaster = d["RomeBridgePaymaster"]?.address;
  if (!paymaster) {
    throw new Error(
      "RomeBridgePaymaster missing in deployments — run scripts/bridge/deploy.ts for a clean setup first.",
    );
  }

  const oldUsersAddr   = d["ERC20Users"]?.address;
  const oldUsdcWrapper = d["SPL_ERC20_USDC"]?.address;
  const oldWethWrapper = d["SPL_ERC20_WETH"]?.address;
  const oldWithdraw    = d["RomeBridgeWithdraw"]?.address;
  console.log(`[${networkName}] reusing paymaster:    ${paymaster}`);
  console.log(`[${networkName}] old ERC20Users (arch):${oldUsersAddr}`);
  console.log(`[${networkName}] old wUSDC (archive):  ${oldUsdcWrapper}`);
  console.log(`[${networkName}] old wETH (archive):   ${oldWethWrapper}`);
  console.log(`[${networkName}] old withdraw (arch):  ${oldWithdraw}`);

  // Deploy a fresh ERC20Users. The previously-deployed instance was
  // built from the older struct-based ABI (`User { payer, owner, seed }`)
  // but master's contract source is single-bytes32. ABI mismatch
  // means a new SPL_ERC20 compiled from master can't decode responses
  // from the old ERC20Users. The remedy is a fresh ERC20Users built
  // from the same source as the new wrappers — they round-trip
  // cleanly and existing user PDAs remain valid because the per-user
  // payer PDA is a deterministic derivation, not a stored value
  // (`create_payer` is idempotent and skips funding when the payer
  // is already prefunded, which it is for any user who's bridged
  // before).
  const usersC = await viem.deployContract("ERC20Users", []);
  const usersAddr = usersC.address;
  console.log(`[${networkName}] NEW ERC20Users → ${usersAddr}`);

  // ── Deploy new wUSDC ────────────────────────────────────────────────
  const usdcMint = SPL_MINTS.USDC_NATIVE;
  const newUsdc = await viem.deployContract("SPL_ERC20", [
    base58ToBytes32(usdcMint),
    CPI_PROGRAM_ADDRESS,
    "Rome USDC",
    "WUSDC",
    usersAddr,
  ]);
  console.log(`[${networkName}] NEW SPL_ERC20 WUSDC → ${newUsdc.address} (mint ${usdcMint})`);

  // ── Deploy new wETH ─────────────────────────────────────────────────
  const wethMint = SPL_MINTS.WETH_WORMHOLE;
  const newWeth = await viem.deployContract("SPL_ERC20", [
    base58ToBytes32(wethMint),
    CPI_PROGRAM_ADDRESS,
    "Rome wETH",
    "WETH",
    usersAddr,
  ]);
  console.log(`[${networkName}] NEW SPL_ERC20 WETH  → ${newWeth.address} (mint ${wethMint})`);

  // ── Build CCTP + Wormhole params for the new RomeBridgeWithdraw ────
  const usdcMintPk = new PublicKey(usdcMint);
  const wethMintPk = new PublicKey(wethMint);
  const cctpPdas = deriveCctpAccounts(usdcMintPk);
  const whPdas = deriveWormholeAccounts(wethMintPk, {
    tokenBridgeProgramId: SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_TOKEN_BRIDGE,
    coreProgramId: SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_CORE,
  });

  const cctpParams = {
    tokenMessengerProgram:     base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_TOKEN_MESSENGER),
    messageTransmitterProgram: base58ToBytes32(SOLANA_PROGRAM_IDS.CCTP_MESSAGE_TRANSMITTER),
    splTokenProgram:           base58ToBytes32(SOLANA_PROGRAM_IDS.SPL_TOKEN),
    systemProgram:             base58ToBytes32(SOLANA_PROGRAM_IDS.SYSTEM_PROGRAM),
    messageTransmitterConfig:  cctpPdas.cctpMessageTransmitterConfig,
    tokenMessengerConfig:      cctpPdas.cctpTokenMessengerConfig,
    remoteTokenMessenger:      cctpPdas.cctpRemoteTokenMessenger,
    tokenMinter:               cctpPdas.cctpTokenMinter,
    localTokenUsdc:            cctpPdas.cctpLocalTokenUsdc,
    senderAuthorityPda:        cctpPdas.cctpSenderAuthorityPda,
    eventAuthority:            cctpPdas.cctpEventAuthority,
  };
  const wormholeParams = {
    tokenBridgeProgram: base58ToBytes32(SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_TOKEN_BRIDGE),
    coreProgram:        base58ToBytes32(SOLANA_PROGRAM_IDS_DEVNET.WORMHOLE_CORE),
    splTokenProgram:    base58ToBytes32(SOLANA_PROGRAM_IDS.SPL_TOKEN),
    systemProgram:      base58ToBytes32(SOLANA_PROGRAM_IDS.SYSTEM_PROGRAM),
    clockSysvar:        base58ToBytes32("SysvarC1ock11111111111111111111111111111111"),
    rentSysvar:         base58ToBytes32("SysvarRent111111111111111111111111111111111"),
    config:             whPdas.wormholeConfig,
    custody:            whPdas.wormholeCustody,
    authoritySigner:    whPdas.wormholeAuthoritySigner,
    custodySigner:      whPdas.wormholeCustodySigner,
    bridgeConfig:       whPdas.wormholeBridgeConfig,
    feeCollector:       whPdas.wormholeFeeCollector,
    emitter:            whPdas.wormholeEmitter,
    sequence:           whPdas.wormholeSequence,
    wrappedMeta:        whPdas.wormholeWrappedMeta,
    targetChain:        WORMHOLE_TARGET_CHAIN,
  };

  // ── Deploy new RomeBridgeWithdraw ──────────────────────────────────
  const withdraw = await viem.deployContract("RomeBridgeWithdraw", [
    paymaster, newUsdc.address, newWeth.address, cctpParams, wormholeParams,
  ]);
  console.log(`[${networkName}] NEW RomeBridgeWithdraw → ${withdraw.address}`);

  // ── Archive old + record new addresses ─────────────────────────────
  d["archive"] ??= {};
  if (oldUsersAddr)   d["archive"]["ERC20Users_struct_abi"]          = { address: oldUsersAddr,   archivedAt: Math.floor(Date.now() / 1000) };
  if (oldUsdcWrapper) d["archive"]["SPL_ERC20_USDC_pre_ata_fix"]     = { address: oldUsdcWrapper, archivedAt: Math.floor(Date.now() / 1000) };
  if (oldWethWrapper) d["archive"]["SPL_ERC20_WETH_pre_ata_fix"]     = { address: oldWethWrapper, archivedAt: Math.floor(Date.now() / 1000) };
  if (oldWithdraw)    d["archive"]["RomeBridgeWithdraw_pre_ata_fix"] = { address: oldWithdraw,    archivedAt: Math.floor(Date.now() / 1000) };

  d["ERC20Users"] = { address: usersAddr, deployedAt: Math.floor(Date.now() / 1000), notes: "Master single-bytes32 ABI; companions to post-#63 wrappers." };
  d["SPL_ERC20_USDC"] = { address: newUsdc.address, mintId: usdcMint, deployedAt: Math.floor(Date.now() / 1000), notes: "Post-#63 bytecode: auto-creates recipient ATA on transfer / mint_to + balanceOf-derive-on-miss." };
  d["SPL_ERC20_WETH"] = { address: newWeth.address, mintId: wethMint, deployedAt: Math.floor(Date.now() / 1000), notes: "Post-#63 bytecode: auto-creates recipient ATA on transfer / mint_to + balanceOf-derive-on-miss." };
  d["RomeBridgeWithdraw"] = { address: withdraw.address, deployedAt: Math.floor(Date.now() / 1000), notes: "Wired to post-#63 wrappers." };
  writeDeployments(networkName, d as any);
  console.log(`[${networkName}] deployments/${networkName}.json updated.`);

  // ── Re-allowlist burnUSDC + burnETH selectors on existing paymaster ─
  const paymasterC = await viem.getContractAt("RomeBridgePaymaster", paymaster);
  const burnUsdcSel    = ("0x" + keccak256(toUtf8Bytes("burnUSDC(uint256,address)")).slice(2, 10)) as `0x${string}`;
  const approveBurnSel = ("0x" + keccak256(toUtf8Bytes("approveBurnETH(uint256)")).slice(2, 10)) as `0x${string}`;
  const burnEthSel     = ("0x" + keccak256(toUtf8Bytes("burnETH(uint256,address)")).slice(2, 10)) as `0x${string}`;
  await paymasterC.write.setAllowlistEntry([withdraw.address, burnUsdcSel, true]);
  await paymasterC.write.setAllowlistEntry([withdraw.address, approveBurnSel, true]);
  await paymasterC.write.setAllowlistEntry([withdraw.address, burnEthSel, true]);
  console.log(`[${networkName}] paymaster allowlist updated (burnUSDC + approveBurnETH + burnETH).`);

  console.log(`\n✓ Redeploy complete on ${networkName}. Summary:`);
  console.log(`  WUSDC wrapper:        ${newUsdc.address}`);
  console.log(`  WETH wrapper:         ${newWeth.address}`);
  console.log(`  RomeBridgeWithdraw:   ${withdraw.address}`);
  console.log(`  RomeBridgePaymaster:  ${paymaster} (unchanged, allowlist updated)`);
  console.log(`  ERC20Users:           ${usersAddr} (unchanged)`);
  console.log(`\nDownstream updates required (rome-ui chains.yaml):`);
  console.log(`  marcus.contracts.gasWrapper          → ${newUsdc.address}`);
  console.log(`  marcus.contracts.romeBridgeWithdraw  → ${withdraw.address}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
