// scripts/activation/seed-activation-pool.ts
//
// Seeds initial WUSDC↔WSOL Romeswap liquidity so PdaActivator.activate
// has a pool to swap against. Run by the operator once per chain after
// deploy-pda-activator.ts. The operator is the only LP at chain
// bring-up; LPs/arbitrageurs can add later.
//
// Prerequisites (operator-runbook, NOT automated here):
//   1. Operator's EVM address holds at least `seedWusdcAmount` of WUSDC
//      wrapper balance. Acquired via:
//        - bridging USDC into Marcus and wrapping (`wrap_gas_to_spl`), or
//        - having USDC native gas and calling `wrap_gas_to_spl(amount)`
//          directly from operator's address.
//   2. Operator's Rome PDA holds at least `seedWsolAmount` worth of
//      wSOL SPL. Acquired off-chain by:
//        - on a Solana wallet: `spl-token wrap <amount>` (creates a
//          wSOL ATA and deposits SOL), or `spl-token transfer
//          So11..112 <amount> <operator-pda-wsol-ata> --fund-recipient`
//        - operator's PDA wSOL ATA address: derive via
//          `getATA(externalAuthPda(operatorEvmAddress), So11..112)`
//        - confirm via `wsolWrapper.balanceOf(operator)` from EVM-side
//
// Once the prerequisites are in place, this script:
//   - Approves the Romeswap router for both balances
//   - Calls router.addLiquidity(WUSDC, WSOL, ...) with the seed amounts
//   - Persists the LP token id + pool address to deployments/<network>.json
//
// Sizing guidance (devnet): start with $10–$50 worth on each side. Pool
// thinness sets the floor for activation slippage; deeper pool = better
// UX but more operator capital. Mainnet: depth tuned to expected
// activation throughput.

import hardhat from "hardhat";
import { parseUnits } from "viem";
import { readDeployments, writeDeployments } from "../lib/deployments.js";

// Defaults for devnet first deploy. Override via env.
const DEFAULT_SEED_WUSDC_USDC = "10";   // 10 WUSDC (= 10_000_000 base units)
const DEFAULT_SEED_WSOL_SOL = "0.1";    // 0.1 wSOL  (= 100_000_000 lamports)

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [operator] = await viem.getWalletClients();
  if (!operator?.account) {
    throw new Error("No operator wallet — set <NETWORK>_PRIVATE_KEY in the keystore");
  }
  const publicClient = await viem.getPublicClient();

  const deployments = readDeployments(networkName) as Record<string, unknown>;
  const usdcEntry = deployments.SPL_ERC20_USDC as { address?: string } | undefined;
  const wsolEntry = deployments.SPL_ERC20_WSOL as { address?: string } | undefined;
  const activatorEntry = deployments.PdaActivator as
    | { address?: string; romeswapRouter?: string }
    | undefined;

  if (!usdcEntry?.address) throw new Error(`SPL_ERC20_USDC not in deployments/${networkName}.json — run bootstrap-bridged-wrappers.ts`);
  if (!wsolEntry?.address) throw new Error(`SPL_ERC20_WSOL not in deployments/${networkName}.json — run deploy-pda-activator.ts`);
  if (!activatorEntry?.romeswapRouter) throw new Error(`PdaActivator entry missing romeswapRouter — run deploy-pda-activator.ts`);

  const wusdcAddress = usdcEntry.address as `0x${string}`;
  const wsolAddress = wsolEntry.address as `0x${string}`;
  const routerAddress = activatorEntry.romeswapRouter as `0x${string}`;

  // Amounts in base units. WUSDC=6, wSOL=9.
  const seedWusdcInput = process.env.SEED_WUSDC ?? DEFAULT_SEED_WUSDC_USDC;
  const seedWsolInput = process.env.SEED_WSOL ?? DEFAULT_SEED_WSOL_SOL;
  const seedWusdcBaseUnits = parseUnits(seedWusdcInput, 6);
  const seedWsolBaseUnits = parseUnits(seedWsolInput, 9);

  console.log(`[${networkName}] operator:        ${operator.account.address}`);
  console.log(`[${networkName}] WUSDC wrapper:   ${wusdcAddress}`);
  console.log(`[${networkName}] WSOL wrapper:    ${wsolAddress}`);
  console.log(`[${networkName}] Romeswap router: ${routerAddress}`);
  console.log(`[${networkName}] seed WUSDC:      ${seedWusdcInput} (${seedWusdcBaseUnits} base units)`);
  console.log(`[${networkName}] seed wSOL:       ${seedWsolInput}  (${seedWsolBaseUnits} base units)`);

  // Sanity-check operator balances before doing anything.
  const wusdc = await viem.getContractAt("SPL_ERC20", wusdcAddress);
  const wsol = await viem.getContractAt("SPL_ERC20", wsolAddress);
  const wusdcBal = (await wusdc.read.balanceOf([operator.account.address])) as bigint;
  const wsolBal = (await wsol.read.balanceOf([operator.account.address])) as bigint;
  console.log(`\n  operator WUSDC balance: ${wusdcBal}`);
  console.log(`  operator wSOL balance:  ${wsolBal}`);
  if (wusdcBal < seedWusdcBaseUnits) {
    throw new Error(`operator WUSDC balance ${wusdcBal} < seed ${seedWusdcBaseUnits}. Wrap more native gas (wrap_gas_to_spl) before re-running.`);
  }
  if (wsolBal < seedWsolBaseUnits) {
    throw new Error(`operator wSOL balance ${wsolBal} < seed ${seedWsolBaseUnits}. See header docs for how to acquire wSOL.`);
  }

  // Approve router for both legs.
  console.log("\n[1/3] Approving router for WUSDC ...");
  let txHash = await wusdc.write.approve([routerAddress, seedWusdcBaseUnits]);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`       tx: ${txHash}`);

  console.log("\n[2/3] Approving router for wSOL ...");
  txHash = await wsol.write.approve([routerAddress, seedWsolBaseUnits]);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`       tx: ${txHash}`);

  // addLiquidity. Slippage 0 because we're seeding (no prior price).
  console.log("\n[3/3] Adding initial WUSDC↔WSOL liquidity ...");
  const router = await viem.getContractAt("UniswapV2Router02", routerAddress);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const addTx = await router.write.addLiquidity([
    wusdcAddress,
    wsolAddress,
    seedWusdcBaseUnits,
    seedWsolBaseUnits,
    seedWusdcBaseUnits, // amountAMin = exact (initial seed sets the price)
    seedWsolBaseUnits,  // amountBMin = exact
    operator.account.address,
    deadline,
  ]);
  const rc = await publicClient.waitForTransactionReceipt({ hash: addTx });
  console.log(`       tx: ${addTx}`);
  console.log(`       block: ${rc.blockNumber}`);

  // Persist
  deployments.PdaActivatorPool = {
    wusdcAddress,
    wsolAddress,
    seedWusdc: seedWusdcBaseUnits.toString(),
    seedWsol: seedWsolBaseUnits.toString(),
    addLiquidityTx: addTx,
    seededAt: Math.floor(Date.now() / 1000),
  };
  writeDeployments(networkName, deployments);

  console.log(`\nSaved → deployments/${networkName}.json`);
  console.log("\nActivation pool live. Users can now call PdaActivator.activate{value: activationCost}().");
}

main().catch((err) => { console.error(err); process.exit(1); });
