// scripts/activation/deploy-pda-activator.ts
//
// Deploys PdaActivator on a chain. Plumbs the chain's pre-existing
// Meteora gas-pricing pool as the swap venue. Adds two prereqs to
// the chain's deployments if missing:
//
//   1. WSOL `SPL_ERC20` wrapper — registered via
//      ERC20SPLFactory.add_spl_token_no_metadata for wSOL mint
//      So11..112. The Meteora pool's wSOL leg needs an ERC20
//      representation on the Rome side.
//
//   2. DAMMv1Pool Solidity wrapper bound to the chain's gas-pricing
//      pool — registered via MeteoraDAMMv1Factory.addPool(pubkey).
//      The Solana pool itself was created during /prepare-rollup;
//      this just deploys a Solidity surface for it.
//
// Then deploys PdaActivator with all addresses wired.
//
// Reads the gas-pricing pool pubkey from
//   ../rome-ops/ansible/deployments/registry.json[chain].gas_pricing.meteora_pool
// (operator-private). The pool is also at registry/chains/<id>-<slug>/
// chain.json#gasPool but the Layer-2 registry has the canonical reference.

import fs from "node:fs";
import path from "node:path";
import hardhat from "hardhat";
import {
  resolveERC20SPLFactoryAddress,
  readDeployments,
  writeDeployments,
} from "../lib/deployments.js";
import { base58ToBytes32 } from "../lib/pubkey.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const WSOL_MINT_BASE58 = "So11111111111111111111111111111111111111112";
const WSOL_NAME = "Rome Wrapped SOL";
const WSOL_SYMBOL = "WSOL";
const SPL_TOKEN_PROGRAM_BASE58 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// 0.002 USDC native gas → ~10M lamports on PDA after pool slippage.
const ACTIVATION_COST_WEI = 2_000_000_000_000_000n;

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [deployer] = await viem.getWalletClients();
  if (!deployer?.account) {
    throw new Error("No deployer wallet — set <NETWORK>_PRIVATE_KEY in the keystore");
  }
  const publicClient = await viem.getPublicClient();

  const factoryAddress = resolveERC20SPLFactoryAddress(networkName);
  const factory = await viem.getContractAt("ERC20SPLFactory", factoryAddress);
  const usdcWrapperAddress = readUsdcWrapperAddress(networkName);
  const meteoraFactoryAddress = readMeteoraFactoryAddress(networkName);
  const gasPricingPoolPubkey = readGasPricingPoolPubkey(networkName);

  console.log(`[${networkName}] deployer:               ${deployer.account.address}`);
  console.log(`[${networkName}] ERC20SPLFactory:        ${factoryAddress}`);
  console.log(`[${networkName}] WUSDC wrapper:          ${usdcWrapperAddress}`);
  console.log(`[${networkName}] MeteoraDAMMv1Factory:   ${meteoraFactoryAddress}`);
  console.log(`[${networkName}] Gas-pricing pool (sol): ${gasPricingPoolPubkey}`);

  // 1. Register WSOL wrapper (idempotent).
  const wsolMintBytes32 = base58ToBytes32(WSOL_MINT_BASE58);
  let wsolWrapperAddress = (await factory.read.token_by_mint([wsolMintBytes32])) as `0x${string}`;
  if (wsolWrapperAddress.toLowerCase() === ZERO_ADDRESS) {
    console.log("\n[1/3] Registering WSOL wrapper ...");
    const tx = await factory.write.add_spl_token_no_metadata([wsolMintBytes32, WSOL_NAME, WSOL_SYMBOL]);
    await publicClient.waitForTransactionReceipt({ hash: tx });
    wsolWrapperAddress = (await factory.read.token_by_mint([wsolMintBytes32])) as `0x${string}`;
    console.log(`       wrapper: ${wsolWrapperAddress}`);
  } else {
    console.log(`\n[1/3] WSOL wrapper exists → ${wsolWrapperAddress}`);
  }

  // 2. Register DAMMv1Pool wrapper for the gas-pricing pool (idempotent).
  const meteoraFactory = await viem.getContractAt("MeteoraDAMMv1Factory", meteoraFactoryAddress);
  const poolPubkeyBytes32 = base58ToBytes32(gasPricingPoolPubkey);
  // Try to read an existing wrapper; otherwise call addPool.
  // (The factory exposes addPool which is idempotent if pool already registered.)
  console.log("\n[2/3] Registering DAMMv1Pool Solidity wrapper for gas-pricing pool ...");
  const addPoolTx = await meteoraFactory.write.addPool([poolPubkeyBytes32]);
  const addPoolRcpt = await publicClient.waitForTransactionReceipt({ hash: addPoolTx });
  // Decode the resulting pool address from the tx return value or events.
  // For now, capture a console pointer; deployer reads from emitted PoolRegistered event in operator runbook.
  console.log(`       tx: ${addPoolTx} (block ${addPoolRcpt.blockNumber})`);

  // The factory's addPool returns the pool address; we re-call as a view
  // to capture it via event logs in a follow-up improvement. For now
  // require the operator to read it from the tx logs and pass via env:
  const poolWrapperAddress = (process.env.METEORA_GAS_POOL_WRAPPER ??
    "") as `0x${string}`;
  if (!poolWrapperAddress) {
    throw new Error(
      "Set METEORA_GAS_POOL_WRAPPER to the DAMMv1Pool address logged in step 2 (read from tx receipt) and re-run.",
    );
  }
  console.log(`       pool wrapper: ${poolWrapperAddress}`);

  // 3. Deploy PdaActivator.
  console.log("\n[3/3] Deploying PdaActivator ...");
  const splTokenProgramBytes32 = base58ToBytes32(SPL_TOKEN_PROGRAM_BASE58);
  const activator = await viem.deployContract("PdaActivator", [
    usdcWrapperAddress,
    wsolWrapperAddress,
    poolWrapperAddress,
    base58ToBytes32(WSOL_MINT_BASE58),
    splTokenProgramBytes32,
    ACTIVATION_COST_WEI,
  ]);
  const activatorAddress = activator.address;
  console.log(`       address:        ${activatorAddress}`);
  console.log(`       activationCost: ${ACTIVATION_COST_WEI} wei`);

  // 4. Persist.
  const deployments = readDeployments(networkName) as Record<string, unknown>;
  deployments.PdaActivator = {
    address: activatorAddress,
    activationCostWei: ACTIVATION_COST_WEI.toString(),
    wsolWrapper: wsolWrapperAddress,
    wsolMintBase58: WSOL_MINT_BASE58,
    usdcWrapper: usdcWrapperAddress,
    meteoraPoolWrapper: poolWrapperAddress,
    meteoraPoolPubkey: gasPricingPoolPubkey,
    splTokenProgramBase58: SPL_TOKEN_PROGRAM_BASE58,
    deployedAt: Math.floor(Date.now() / 1000),
  };
  deployments.SPL_ERC20_WSOL = {
    address: wsolWrapperAddress,
    mintId: WSOL_MINT_BASE58,
    name: WSOL_NAME,
    symbol: WSOL_SYMBOL,
    via: "ERC20SPLFactory.add_spl_token_no_metadata",
  };
  writeDeployments(networkName, deployments);
  console.log(`\nSaved → deployments/${networkName}.json`);
  console.log(
    `\nPdaActivator deployed. Update registry chain.json#contracts.pdaActivator = ${activatorAddress} so rome-ui surfaces the Activate button.`,
  );
}

function readUsdcWrapperAddress(networkName: string): `0x${string}` {
  const d = readDeployments(networkName) as Record<string, unknown>;
  const usdc = d.SPL_ERC20_USDC as { address?: string } | undefined;
  if (!usdc?.address)
    throw new Error(`SPL_ERC20_USDC missing in deployments/${networkName}.json`);
  return usdc.address as `0x${string}`;
}

function readMeteoraFactoryAddress(networkName: string): `0x${string}` {
  const d = readDeployments(networkName) as Record<string, unknown>;
  const f = d.MeteoraDAMMv1Factory as { address?: string } | undefined;
  if (!f?.address)
    throw new Error(`MeteoraDAMMv1Factory missing in deployments/${networkName}.json`);
  return f.address as `0x${string}`;
}

function readGasPricingPoolPubkey(networkName: string): string {
  // Read from rome-ops/ansible/deployments/registry.json (Layer 2 — operator-private).
  const candidates = [
    path.resolve(process.cwd(), "..", "rome-ops", "ansible", "deployments", "registry.json"),
    path.resolve(process.cwd(), "..", "..", "rome-ops", "ansible", "deployments", "registry.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const arr = JSON.parse(fs.readFileSync(c, "utf8"));
      const entry = arr.find((e: { rollup_name?: string }) => e.rollup_name === networkName);
      if (!entry) continue;
      const pool = entry?.gas_pricing?.meteora_pool;
      if (typeof pool === "string" && pool.length > 0) return pool;
    }
  }
  throw new Error(
    `Could not find gas_pricing.meteora_pool for ${networkName} in rome-ops registry.json. Tried: ${candidates.join(", ")}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
