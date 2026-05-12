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
// Reads the wrapper + users addresses from env / sensible defaults.
//
// Writes deployment record to deployments/<network>.json under the
// SimpleActivator key, matching the bridge / oracle / meteora convention. The
// contract-deploys activation-deploy.yml workflow PRs this file back to
// rome-solidity master after a CI deploy.

import hardhat from "hardhat";
import { readDeployments, writeDeployments } from "../lib/deployments.js";

// Three-call activation: 1 USDC for activate(), 0.5 USDC for each
// ATA-create call. Total user cost = 1 + 0.5 + 0.5 = 2 USDC,
// matching the prior two-call total. Operator margin per call covers
// the ~2M lamports of SOL outflow (ATA rent + activator PDA topup).
const ACTIVATION_COST_WEI = 1_000_000_000_000_000_000n;
const TOKEN_ACCOUNTS_COST_WEI = 500_000_000_000_000_000n;

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [deployer] = await viem.getWalletClients();
  if (!deployer?.account) {
    throw new Error("No deployer wallet — set <NETWORK>_PRIVATE_KEY");
  }

  // Marcus 121301 defaults — override via env for other chains.
  const usdcWrapper =
    (process.env.USDC_WRAPPER as `0x${string}`) ||
    "0x39844f1d605a11acd87f766494291bbd11b406f4";
  const wsolWrapper =
    (process.env.WSOL_WRAPPER as `0x${string}`) ||
    "0xc180a9133770d48f33cBDe630205a7B7DDA48fF6";
  const factory =
    (process.env.ERC20_SPL_FACTORY as `0x${string}`) ||
    "0xbd0a59183cd4178b8b000036c64c7aeef4619be1";

  // Read users() from the factory.
  const factoryContract = await viem.getContractAt("ERC20SPLFactory", factory);
  const usersAddr = (await factoryContract.read.users()) as `0x${string}`;

  console.log(`[${networkName}] deployer:        ${deployer.account.address}`);
  console.log(`[${networkName}] usdcWrapper:     ${usdcWrapper}`);
  console.log(`[${networkName}] wsolWrapper:     ${wsolWrapper}`);
  console.log(`[${networkName}] factory:         ${factory}`);
  console.log(`[${networkName}] users (resolved): ${usersAddr}`);
  console.log(`[${networkName}] activationCost:    ${ACTIVATION_COST_WEI} wei (= ${Number(ACTIVATION_COST_WEI) / 1e18} USDC)`);
  console.log(`[${networkName}] tokenAccountsCost: ${TOKEN_ACCOUNTS_COST_WEI} wei (= ${Number(TOKEN_ACCOUNTS_COST_WEI) / 1e18} USDC)`);

  console.log("\nDeploying SimpleActivator ...");
  const activator = await viem.deployContract("SimpleActivator", [
    ACTIVATION_COST_WEI,
    TOKEN_ACCOUNTS_COST_WEI,
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
    tokenAccountsCostWei: TOKEN_ACCOUNTS_COST_WEI.toString(),
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
  console.log(`  4. From a fresh EVM address: UI fires activate() (1 USDC), createWusdcAta() (0.5 USDC), createWsolAta() (0.5 USDC) sequentially.`);
  console.log(`  5. Verify on-chain: PDA exists with 890,880 lamports, WUSDC + WSOL ATAs both exist owned by PDA.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
