// scripts/bridge/bootstrap-bridged-wrappers.ts
//
// Registers the canonical bridged-asset SPL mints (USDC, WETH) on the
// chain's ERC20SPLFactory. Run once after deploying the factory on a
// fresh chain — the resulting `TokenCreated` events are what the
// rome-ui backend's token watcher consumes to populate Portfolio /
// Swap / TokenSelectModal. Wrappers deployed via direct
// `new SPL_ERC20(...)` (e.g. legacy bridge redeploy scripts) bypass
// this event and never appear in the UI; this script keeps the
// canonical wrappers on the indexed path.
//
// Idempotent: skips mints that already have a wrapper registered
// (`factory.token_by_mint(mint) != 0`).

import fs from "node:fs";
import hardhat from "hardhat";
import { resolveERC20SPLFactoryAddress } from "../lib/deployments.js";
import { base58ToBytes32 } from "../lib/pubkey.js";
import { SPL_MINTS_DEVNET, SPL_MINTS_MAINNET } from "./constants.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type WrapperSpec = {
  key: string;          // deployments.json key (e.g. "SPL_ERC20_USDC")
  mintBase58: string;   // SPL mint
  name: string;         // ERC20 name
  symbol: string;       // ERC20 symbol — must be unique within the factory
};

// Canonical bridged set. Symbols match rome-ui's gas-wrapper-split
// convention: native gas = "USDC", wrapped = "wUSDC"; native chain =
// nothing here (we don't wrap an EVM-native), wormhole-wrapped ETH =
// "wETH". Tracked separately for devnet / mainnet because the mint
// addresses differ.
const DEVNET_SET: WrapperSpec[] = [
  { key: "SPL_ERC20_USDC", mintBase58: SPL_MINTS_DEVNET.USDC_NATIVE,   name: "Rome USDC", symbol: "wUSDC" },
  { key: "SPL_ERC20_WETH", mintBase58: SPL_MINTS_DEVNET.WETH_WORMHOLE, name: "Rome ETH",  symbol: "wETH"  },
];

const MAINNET_SET: WrapperSpec[] = [
  { key: "SPL_ERC20_USDC", mintBase58: SPL_MINTS_MAINNET.USDC_NATIVE,   name: "Rome USDC", symbol: "wUSDC" },
  { key: "SPL_ERC20_WETH", mintBase58: SPL_MINTS_MAINNET.WETH_WORMHOLE, name: "Rome ETH",  symbol: "wETH"  },
];

// Devnet networks use the devnet mint set; everything else uses
// mainnet. Override via `BRIDGED_SET=devnet|mainnet` env var when the
// network name doesn't match the convention (e.g. a one-off testnet).
function resolveSet(networkName: string): WrapperSpec[] {
  const override = process.env.BRIDGED_SET?.toLowerCase();
  if (override === "devnet")  return DEVNET_SET;
  if (override === "mainnet") return MAINNET_SET;
  const isDevnet = ["local", "marcus", "monti_spl", "subura", "esquiline"].includes(networkName);
  return isDevnet ? DEVNET_SET : MAINNET_SET;
}

type DeploymentsJson = Record<string, unknown>;

function loadJson(path: string): DeploymentsJson {
  return fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) as DeploymentsJson : {};
}

function saveJson(path: string, data: DeploymentsJson): void {
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [deployer] = await viem.getWalletClients();
  if (!deployer?.account) throw new Error("No deployer wallet — set <NETWORK>_PRIVATE_KEY in the keystore");

  const factoryAddress = resolveERC20SPLFactoryAddress(networkName);
  const factory = await viem.getContractAt("ERC20SPLFactory", factoryAddress);
  const publicClient = await viem.getPublicClient();
  const set = resolveSet(networkName);

  console.log(`[${networkName}] deployer: ${deployer.account.address}`);
  console.log(`[${networkName}] factory:  ${factoryAddress}`);
  console.log(`[${networkName}] mint set: ${set === DEVNET_SET ? "devnet" : "mainnet"} (${set.length} entries)\n`);

  const deploymentsPath = `deployments/${networkName}.json`;
  const deployments = loadJson(deploymentsPath);

  for (const { key, mintBase58, name, symbol } of set) {
    const mint = base58ToBytes32(mintBase58);
    const existing = (await factory.read.token_by_mint([mint])) as `0x${string}`;

    if (existing.toLowerCase() !== ZERO_ADDRESS) {
      console.log(`  ${symbol}: already registered → ${existing}`);
      deployments[key] = { address: existing, mintId: mintBase58, name, symbol };
      continue;
    }

    console.log(`  ${symbol}: registering mint ${mintBase58} ...`);
    const txHash = await factory.write.add_spl_token_no_metadata([mint, name, symbol]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    const wrapperAddress = (await factory.read.token_by_mint([mint])) as `0x${string}`;
    if (wrapperAddress.toLowerCase() === ZERO_ADDRESS) {
      throw new Error(`add_spl_token_no_metadata for ${symbol} landed but token_by_mint is still zero`);
    }
    console.log(`           tx: ${txHash}`);
    console.log(`           wrapper: ${wrapperAddress}`);

    deployments[key] = {
      address: wrapperAddress,
      mintId: mintBase58,
      name,
      symbol,
      deployedAt: Math.floor(Date.now() / 1000),
      via: "ERC20SPLFactory.add_spl_token_no_metadata",
    };
  }

  saveJson(deploymentsPath, deployments);
  console.log(`\nSaved → ${deploymentsPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
