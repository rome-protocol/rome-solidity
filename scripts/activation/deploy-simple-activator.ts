// scripts/activation/deploy-simple-activator.ts
//
// Deploys SimpleActivator on the target chain.
//
// Constructor takes:
//   - activationCost  (uint256, wei)  — what the user pays per activate()
//   - usdcWrapper     (SPL_ERC20)     — chain's gas-mint wrapper
//   - wsolWrapper     (SPL_ERC20)     — canonical wSOL wrapper
//   - users           (ERC20Users)    — shared users mapping (from factory.users())
//
// Address resolution per dependency, in precedence order:
//   1. Explicit env var (USDC_WRAPPER / WSOL_WRAPPER / ERC20_SPL_FACTORY) —
//      what the contract-deploys activation-deploy.yml workflow injects after
//      reading deployments/<network>.json.
//   2. Local deployments/<network>.json (WUSDC.address / WSOL.address /
//      ERC20SPLFactory.address) — what bootstrap-bridged-wrappers.ts and
//      erc20spl-factory deploy write.
//   3. Hard fail with a clear message naming the missing entry.
//
// Writes its own deployment record to deployments/<network>.json under the
// SimpleActivator key. The activation-deploy.yml workflow PRs that diff back to
// rome-solidity master after a CI deploy.

import hardhat from "hardhat";
import { getAddress, isAddress } from "viem";
import { readDeployments, writeDeployments } from "../lib/deployments.js";

// One-tx activation: 2 USDC for activate(). Covers operator's SOL
// outflow for HelperProgram.create_pda (≈ 0.015 SOL = 14_969_440
// lamports of user PDA funding = rent + 2× ATA rent + ~5 fresh-recipient
// transfer reserve) plus a margin for Sybil resistance. Single tx,
// single popup — collapsed from the legacy 3-tx flow.
const ACTIVATION_COST_WEI = 2_000_000_000_000_000_000n;

type AddressDep = {
  envVar: string;
  deploymentsKey: "SPL_ERC20_USDC" | "SPL_ERC20_WSOL" | "ERC20SPLFactory";
  bootstrapHint: string;
};

function resolveAddress(networkName: string, dep: AddressDep): `0x${string}` {
  const envValue = process.env[dep.envVar];
  if (envValue) {
    if (!isAddress(envValue)) {
      throw new Error(`Invalid ${dep.envVar}: ${envValue}`);
    }
    return getAddress(envValue);
  }

  const fromFile = readDeployments(networkName)[dep.deploymentsKey]?.address;
  if (fromFile) {
    if (!isAddress(fromFile)) {
      throw new Error(
        `Invalid ${dep.deploymentsKey}.address in deployments/${networkName}.json: ${fromFile}`,
      );
    }
    return getAddress(fromFile);
  }

  throw new Error(
    `Cannot resolve ${dep.deploymentsKey} address for "${networkName}". ` +
      `Set ${dep.envVar} or add a "${dep.deploymentsKey}.address" entry to deployments/${networkName}.json (${dep.bootstrapHint}).`,
  );
}

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [deployer] = await viem.getWalletClients();
  if (!deployer?.account) {
    throw new Error("No deployer wallet — set <NETWORK>_PRIVATE_KEY");
  }

  const usdcWrapper = resolveAddress(networkName, {
    envVar: "USDC_WRAPPER",
    deploymentsKey: "SPL_ERC20_USDC",
    bootstrapHint: "run scripts/bridge/bootstrap-bridged-wrappers.ts on this chain first",
  });
  const wsolWrapper = resolveAddress(networkName, {
    envVar: "WSOL_WRAPPER",
    deploymentsKey: "SPL_ERC20_WSOL",
    bootstrapHint: "run scripts/bridge/bootstrap-bridged-wrappers.ts on this chain first (registers WSOL alongside USDC/WETH since 2026-05-13)",
  });
  const factory = resolveAddress(networkName, {
    envVar: "ERC20_SPL_FACTORY",
    deploymentsKey: "ERC20SPLFactory",
    bootstrapHint: "run scripts/deploy_erc20spl_factory.ts on this chain first",
  });

  // Read users() from the factory.
  const factoryContract = await viem.getContractAt("ERC20SPLFactory", factory);
  const usersAddr = (await factoryContract.read.users()) as `0x${string}`;

  console.log(`[${networkName}] deployer:        ${deployer.account.address}`);
  console.log(`[${networkName}] usdcWrapper:     ${usdcWrapper}`);
  console.log(`[${networkName}] wsolWrapper:     ${wsolWrapper}`);
  console.log(`[${networkName}] factory:         ${factory}`);
  console.log(`[${networkName}] users (resolved): ${usersAddr}`);
  console.log(`[${networkName}] activationCost:    ${ACTIVATION_COST_WEI} wei (= ${Number(ACTIVATION_COST_WEI) / 1e18} USDC)`);

  console.log("\nDeploying SimpleActivator ...");
  const activator = await viem.deployContract("SimpleActivator", [
    ACTIVATION_COST_WEI,
    usdcWrapper,
    wsolWrapper,
    usersAddr,
  ]);
  console.log(`  address: ${activator.address}`);

  // Persist deployment record to deployments/<network>.json so the
  // contract-deploys activation-deploy.yml workflow PR-back step has a
  // non-empty diff. Matches bridge / oracle / meteora convention.
  const existing = readDeployments(networkName);
  existing.SimpleActivator = {
    address: activator.address,
    activationCostWei: ACTIVATION_COST_WEI.toString(),
    usdcWrapper,
    wsolWrapper,
    users: usersAddr,
    deployedAt: Math.floor(Date.now() / 1000),
  };
  writeDeployments(networkName, existing);
  console.log(`  recorded in deployments/${networkName}.json`);

  console.log("\nNext steps:");
  console.log(`  1. Merge the contract-deploys PR-back to rome-solidity master.`);
  console.log(`  2. Update chain.contracts.simpleActivator in registry/chains/<id>-<slug>/contracts.json.`);
  console.log(`  3. Bump rome_ui_registry_ref in the chain's rome-ui inventory + redeploy rome-ui so ActivationGate picks up the new address.`);
  console.log(`  4. From a fresh EVM address: UI fires a single activate() tx (2 USDC) — one MetaMask popup, one wait.`);
  console.log(`  5. Verify on-chain: PDA exists with USER_PDA_FUNDING lamports (~14.97M), wUSDC + wSOL ATAs both exist owned by PDA.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
