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

import hardhat from "hardhat";

// Two-call activation: 1 USDC each, total 2 USDC matches v3.
// Tune to taste per environment.
const ACTIVATION_COST_WEI = 1_000_000_000_000_000_000n;
const TOKEN_ACCOUNTS_COST_WEI = 1_000_000_000_000_000_000n;

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

  console.log("\nNext steps:");
  console.log(`  1. Update debug-portal/activate.html simpleActivator default.`);
  console.log(`  2. From a fresh EVM address: UI fires activate() (1 USDC) then createTokenAccounts() (1 USDC) sequentially.`);
  console.log(`  3. Verify on-chain: PDA exists with 890,880 lamports, WUSDC + WSOL ATAs both exist owned by PDA.`);
  console.log(`  4. Then: try a Meteora swap from the same wallet — destination ATA exists now, should succeed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
