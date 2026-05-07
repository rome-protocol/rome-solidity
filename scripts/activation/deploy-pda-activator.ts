// scripts/activation/deploy-pda-activator.ts
//
// Deploys the activation primitives on a chain:
//   1. Registers the WSOL SPL_ERC20 wrapper via
//      ERC20SPLFactory.add_spl_token_no_metadata (idempotent — skipped
//      if the wrapper already exists for the WSOL mint)
//   2. Deploys a PdaActivator contract bound to the chain's WUSDC
//      wrapper, the freshly-registered WSOL wrapper, the canonical
//      Romeswap router (read from rome-uniswap-v2/deployments/<chain>.json),
//      and the SPL Token program id
//   3. Persists addresses into deployments/<network>.json
//
// Pool seeding (initial WUSDC↔WSOL Romeswap liquidity) is a separate
// step run by the operator — see seed-activation-pool.ts.
//
// Run after Romeswap router deploy + USDC wrapper bootstrap on a
// fresh chain. Idempotent: re-running on a chain that already has a
// PdaActivator will redeploy a fresh activator (since contract logic
// might evolve) and overwrite the deployments entry. To skip
// redeploy, pass `SKIP_REDEPLOY=1`.

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

// Solana wrapped-SOL mint — same constant on every Solana cluster.
const WSOL_MINT_BASE58 = "So11111111111111111111111111111111111111112";
const WSOL_NAME = "Rome Wrapped SOL";
const WSOL_SYMBOL = "WSOL";

// SPL Token Program (legacy / classic). Same pubkey on every cluster.
const SPL_TOKEN_PROGRAM_BASE58 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// Native gas (USDC, 6 decimals) → SOL lamports per activation.
// Sized so post-pool-slippage the user's PDA receives ≥ ~10M lamports
// (rent-exempt floor for a 0-byte PDA = ~890,880; rest covers a couple
// of ATA creates the first time the user does anything else).
//
// In native gas wei (RSOL_DECIMALS=18). 0.002 USDC = 2,000 micro-USDC =
// 2_000_000_000_000_000 wei.
const ACTIVATION_COST_WEI = 2_000_000_000_000_000n;

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [deployer] = await viem.getWalletClients();
  if (!deployer?.account) {
    throw new Error(
      "No deployer wallet — set <NETWORK>_PRIVATE_KEY in the keystore",
    );
  }
  const publicClient = await viem.getPublicClient();

  // 1. Resolve required addresses
  const factoryAddress = resolveERC20SPLFactoryAddress(networkName);
  const factory = await viem.getContractAt(
    "ERC20SPLFactory",
    factoryAddress,
  );
  const usdcWrapperAddress = readUsdcWrapperAddress(networkName);
  const routerAddress = readRomeswapRouterAddress(networkName);

  console.log(`[${networkName}] deployer:           ${deployer.account.address}`);
  console.log(`[${networkName}] ERC20SPLFactory:    ${factoryAddress}`);
  console.log(`[${networkName}] WUSDC wrapper:      ${usdcWrapperAddress}`);
  console.log(`[${networkName}] Romeswap router:    ${routerAddress}`);
  console.log(`[${networkName}] WSOL mint (Solana): ${WSOL_MINT_BASE58}`);

  // 2. Register WSOL wrapper (idempotent)
  const wsolMintBytes32 = base58ToBytes32(WSOL_MINT_BASE58);
  let wsolWrapperAddress = (await factory.read.token_by_mint([
    wsolMintBytes32,
  ])) as `0x${string}`;

  if (wsolWrapperAddress.toLowerCase() === ZERO_ADDRESS) {
    console.log("\n[1/2] Registering WSOL wrapper via factory.add_spl_token_no_metadata ...");
    const txHash = await factory.write.add_spl_token_no_metadata([
      wsolMintBytes32,
      WSOL_NAME,
      WSOL_SYMBOL,
    ]);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    wsolWrapperAddress = (await factory.read.token_by_mint([
      wsolMintBytes32,
    ])) as `0x${string}`;
    if (wsolWrapperAddress.toLowerCase() === ZERO_ADDRESS) {
      throw new Error("add_spl_token_no_metadata landed but wrapper still zero");
    }
    console.log(`       tx:      ${txHash}`);
    console.log(`       wrapper: ${wsolWrapperAddress}`);
  } else {
    console.log(`\n[1/2] WSOL wrapper already exists → ${wsolWrapperAddress}`);
  }

  // 3. Deploy PdaActivator (or reuse if SKIP_REDEPLOY=1 and exists)
  const deployments = readDeployments(networkName) as Record<string, unknown>;
  const existingActivator = (deployments.PdaActivator as
    | { address?: string }
    | undefined)?.address;

  let activatorAddress: `0x${string}`;
  if (existingActivator && process.env.SKIP_REDEPLOY === "1") {
    console.log(`\n[2/2] Reusing existing PdaActivator (SKIP_REDEPLOY=1) → ${existingActivator}`);
    activatorAddress = existingActivator as `0x${string}`;
  } else {
    console.log("\n[2/2] Deploying PdaActivator ...");
    const splTokenProgramBytes32 = base58ToBytes32(SPL_TOKEN_PROGRAM_BASE58);
    const activator = await viem.deployContract("PdaActivator", [
      usdcWrapperAddress,
      wsolWrapperAddress,
      routerAddress,
      base58ToBytes32(WSOL_MINT_BASE58),
      splTokenProgramBytes32,
      ACTIVATION_COST_WEI,
    ]);
    activatorAddress = activator.address;
    console.log(`       address:        ${activatorAddress}`);
    console.log(`       activationCost: ${ACTIVATION_COST_WEI} wei`);
  }

  // 4. Persist
  deployments.PdaActivator = {
    address: activatorAddress,
    activationCostWei: ACTIVATION_COST_WEI.toString(),
    wsolWrapper: wsolWrapperAddress,
    wsolMintBase58: WSOL_MINT_BASE58,
    usdcWrapper: usdcWrapperAddress,
    romeswapRouter: routerAddress,
    splTokenProgramBase58: SPL_TOKEN_PROGRAM_BASE58,
    deployedAt: Math.floor(Date.now() / 1000),
  };
  // Add the WSOL wrapper to the bridged-wrappers section for symmetry
  // with bootstrap-bridged-wrappers.ts conventions.
  deployments.SPL_ERC20_WSOL = {
    address: wsolWrapperAddress,
    mintId: WSOL_MINT_BASE58,
    name: WSOL_NAME,
    symbol: WSOL_SYMBOL,
    via: "ERC20SPLFactory.add_spl_token_no_metadata",
  };
  writeDeployments(networkName, deployments);

  console.log(`\nSaved → deployments/${networkName}.json`);
  console.log("\nNext step: seed initial WUSDC↔WSOL Romeswap liquidity via seed-activation-pool.ts");
}

// -------------------------------------------------------------------------
// Resolve helpers — both rome-solidity and rome-uniswap-v2 deployments
// -------------------------------------------------------------------------

function readUsdcWrapperAddress(networkName: string): `0x${string}` {
  const deployments = readDeployments(networkName) as Record<string, unknown>;
  const usdc = deployments.SPL_ERC20_USDC as { address?: string } | undefined;
  if (!usdc?.address) {
    throw new Error(
      `SPL_ERC20_USDC not found in deployments/${networkName}.json — run scripts/bridge/bootstrap-bridged-wrappers.ts first`,
    );
  }
  return usdc.address as `0x${string}`;
}

function readRomeswapRouterAddress(networkName: string): `0x${string}` {
  // Romeswap is in rome-uniswap-v2 (sibling repo). We read its
  // deployments/<network>.json file relative to this repo.
  const candidates = [
    path.resolve(process.cwd(), "..", "rome-uniswap-v2", "deployments", `${networkName}.json`),
    path.resolve(
      process.cwd(),
      "..",
      "..",
      "..",
      "rome-uniswap-v2",
      "deployments",
      `${networkName}.json`,
    ),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const data = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const addr = data.routerAddress;
      if (typeof addr !== "string" || !addr.startsWith("0x")) {
        throw new Error(`No routerAddress in ${candidate}`);
      }
      return addr as `0x${string}`;
    }
  }
  throw new Error(
    `Could not find rome-uniswap-v2 deployments/${networkName}.json. Tried: ${candidates.join(", ")}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
