// scripts/activation/redeploy-pda-activator.ts
//
// One-off redeploy script for the PdaActivator chain after a contract-
// code change in `ERC20DAMMv1Pool` (e.g. the Rome-EVM-emulator trailing-
// meta fix in #117).
//
// Strategy: keep the existing inner `DAMMv1Pool` (no need to redeploy
// — its state is intact and the bytecode is unchanged). Deploy a fresh
// `ERC20DAMMv1Pool` wrapper around it (gets the new bytecode), then a
// fresh `PdaActivator` pointing at the new wrapper.
//
// Inputs (from env or registry):
//   EXISTING_PDA_ACTIVATOR — current PdaActivator address; used to
//     read constants (usdcWrapper, wsolWrapper, wsolMint, splTokenProgram,
//     activationCost). Can be omitted if the same constants are present
//     in deployments/<network>.json.
//   EXISTING_POOL_WRAPPER  — current ERC20DAMMv1Pool wrapper address;
//     used to read its internal_pool().
//   ERC20_SPL_FACTORY      — the chain's SPL token factory (resolved
//     from deployments if omitted).

import hardhat from "hardhat";
import {
  resolveERC20SPLFactoryAddress,
  readDeployments,
  writeDeployments,
} from "../lib/deployments.js";

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [deployer] = await viem.getWalletClients();
  if (!deployer?.account) {
    throw new Error("No deployer wallet — set <NETWORK>_PRIVATE_KEY");
  }
  const publicClient = await viem.getPublicClient();

  const existingActivator = process.env.EXISTING_PDA_ACTIVATOR as `0x${string}` | undefined;
  const existingWrapper = process.env.EXISTING_POOL_WRAPPER as `0x${string}` | undefined;
  if (!existingActivator || !existingWrapper) {
    throw new Error(
      "Set EXISTING_PDA_ACTIVATOR and EXISTING_POOL_WRAPPER env vars",
    );
  }

  const erc20SplFactory = (process.env.ERC20_SPL_FACTORY ??
    resolveERC20SPLFactoryAddress(networkName)) as `0x${string}`;

  console.log(`[${networkName}] deployer:                ${deployer.account.address}`);
  console.log(`[${networkName}] ERC20SPLFactory:         ${erc20SplFactory}`);
  console.log(`[${networkName}] existing PdaActivator:   ${existingActivator}`);
  console.log(`[${networkName}] existing pool wrapper:   ${existingWrapper}`);

  const wrapper = await viem.getContractAt("ERC20DAMMv1Pool", existingWrapper);
  const innerPool = (await wrapper.read.internal_pool()) as `0x${string}`;
  console.log(`[${networkName}] inner DAMMv1Pool:        ${innerPool}`);

  const activator = await viem.getContractAt("PdaActivator", existingActivator);
  const usdcWrapper = (await activator.read.usdcWrapper()) as `0x${string}`;
  const wsolWrapper = (await activator.read.wsolWrapper()) as `0x${string}`;
  const wsolMint = (await activator.read.wsolMint()) as `0x${string}`;
  const splTokenProgram = (await activator.read.splTokenProgram()) as `0x${string}`;
  const activationCost = (await activator.read.activationCost()) as bigint;
  console.log(`[${networkName}] usdcWrapper:             ${usdcWrapper}`);
  console.log(`[${networkName}] wsolWrapper:             ${wsolWrapper}`);
  console.log(`[${networkName}] wsolMint (b32):          ${wsolMint}`);
  console.log(`[${networkName}] splTokenProgram (b32):   ${splTokenProgram}`);
  console.log(`[${networkName}] activationCost (wei):    ${activationCost}`);

  // 1. Deploy fresh ERC20DAMMv1Pool wrapping the existing inner pool.
  console.log("\n[1/2] Deploying fresh ERC20DAMMv1Pool ...");
  const newWrapper = await viem.deployContract("ERC20DAMMv1Pool", [
    innerPool,
    erc20SplFactory,
  ]);
  console.log(`       new wrapper: ${newWrapper.address}`);

  // 2. Deploy fresh PdaActivator pointing at the new wrapper.
  console.log("\n[2/2] Deploying fresh PdaActivator ...");
  const newActivator = await viem.deployContract("PdaActivator", [
    usdcWrapper,
    wsolWrapper,
    newWrapper.address,
    wsolMint,
    splTokenProgram,
    activationCost,
  ]);
  console.log(`       new activator: ${newActivator.address}`);

  // 3. Persist receipt.
  const deployments = readDeployments(networkName) as Record<string, unknown>;
  const previous = (deployments.PdaActivator ?? {}) as Record<string, unknown>;
  deployments.PdaActivator = {
    ...previous,
    address: newActivator.address,
    activationCostWei: activationCost.toString(),
    wsolWrapper,
    usdcWrapper,
    meteoraPoolWrapper: newWrapper.address,
    redeployedAt: Math.floor(Date.now() / 1000),
    redeployedReason: "rome-solidity #117 — DAMMv1Lib trailing-prog meta fix",
    previousActivator: existingActivator,
    previousMeteoraPoolWrapper: existingWrapper,
  };
  writeDeployments(networkName, deployments);
  console.log(`\nSaved → deployments/${networkName}.json`);

  console.log(`\nNext steps:`);
  console.log(
    `  1. Update registry chain ${networkName}: contracts.json#PdaActivator → ${newActivator.address} (version 1.0.1).`,
  );
  console.log(
    `  2. Update rome-ui REGISTRY_REF to a new tag including the registry update.`,
  );
  console.log(`  3. Re-test cast estimate PdaActivator.activate(0).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
