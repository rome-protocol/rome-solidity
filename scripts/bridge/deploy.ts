// scripts/bridge/deploy.ts
//
// Per-chain deploy script for the Rome Bridge stack:
//   - ERC20Users (idempotent — reused if already deployed)
//   - RomeBridgeWithdraw 13.0.0 (needs the USDC wrapper; skipped without USDC_MINT)
//
// The legacy RomeBridgePaymaster / RomeBridgeInbound were removed — the active
// flow is user-paid (burnUSDC / burnToWormhole / bridgeOutToSolana signed directly
// from the user's wallet) and inbound is settle_inbound_bridge on the Rome EVM program.
//
// v13 deploys with NO CCTP destination and NO Wormhole allowlist entries: both
// are switched on afterwards by the owner (scripts/bridge/enable-cctp-domains.ts,
// scripts/bridge/set-wormhole-allowlist.ts). The owner and guardian are set here.
//
//   BRIDGE_OWNER     owner address (admin). Defaults to WORMHOLE_ADMIN, then the deployer.
//   BRIDGE_GUARDIAN  stop-only ops key (pause, disable a domain). Defaults to none
//                    (zero address). Must differ from the owner.
//
// TESTNETS ONLY. This script refuses to send unless the RPC reports a listed testnet
// chain id (lib/testnet-guard.ts), so it cannot deploy on Rubicon. The Rubicon deploy of
// 13.0.0 is a separate script, scripts/bridge/deploy-rubicon-v13.ts (owner = the cold
// Ledger and guardian = the ops key from construction, dry run first, print-only owner
// calls); it builds its constructor arguments from the same lib/withdraw-ctor-args.ts.
//
// Mint configuration is per-chain via env vars; constants no longer hard-code
// Rome's mints. Operators always pass the USDC mint explicitly:
//
//   USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU \
//   npx hardhat run scripts/bridge/deploy.ts --network <chain>
//
// Universal Solana constants (program IDs, sysvars) are base58-decoded here.
//
// CPI precompile address: 0xFF00000000000000000000000000000000000008
// (confirmed from contracts/interface.sol: `cpi_program_address`)

import hardhat from "hardhat";
import { readDeployments, writeDeployments } from "../lib/deployments.js";
import { resolveRoles } from "./lib/deploy-roles.js";
import { assertTestnetSend } from "./lib/testnet-guard.js";
import { ZERO_ADDRESS, buildWithdrawConstructorArgs, universalFor } from "./lib/withdraw-ctor-args.js";

// Constructor arguments and the Solana program ids live in lib/withdraw-ctor-args.ts,
// shared with the Rubicon deploy script. Re-exported for scripts/setup-local.ts and the tests.
export { universalFor };

// -------------------------------------------------------------------------
// Deployment functions (exported for use in setup-local.ts)
// -------------------------------------------------------------------------

export async function ensureErc20Users(): Promise<`0x${string}`> {
  const { viem, networkName } = await hardhat.network.connect();
  // Fail closed on the RPC's real chain id, before anything is sent (see lib/testnet-guard.ts).
  await assertTestnetSend(await viem.getPublicClient(), `${networkName} deploy ERC20Users`);
  const d = readDeployments(networkName) as Record<string, any>;
  if (d["ERC20Users"]?.address) {
    console.log(`[${networkName}] ERC20Users already deployed at ${d["ERC20Users"].address}`);
    return d["ERC20Users"].address as `0x${string}`;
  }
  const users = await viem.deployContract("ERC20Users", []);
  const d2 = readDeployments(networkName) as Record<string, any>;
  d2["ERC20Users"] = { address: users.address };
  writeDeployments(networkName, d2 as any);
  console.log(`[${networkName}] ERC20Users → ${users.address}`);
  return users.address as `0x${string}`;
}

// Forward-only: wrappers are ALWAYS created via `bootstrap-bridged-wrappers.ts`
// (which calls `ERC20SPLFactory.add_spl_token_no_metadata` and emits the
// `TokenCreated` event the the Rome app backend indexer subscribes to). This
// helper reads the resulting addresses out of `deployments/<network>.json`
// and hard-fails if missing — there is intentionally no fallback to a
// direct `new SPL_ERC20(...)` deploy because that path would create a
// duplicate wrapper invisible to the indexer (the historic "throwaway
// wrapper" footgun from the pre-2026-05-18 deploy.ts).
function requireExistingWrapper(
  networkName: string,
  key: "SPL_ERC20_USDC",
  symbol: string,
): { address: `0x${string}` } {
  const existing = (readDeployments(networkName) as Record<string, any>)?.[key]?.address;
  if (!existing) {
    throw new Error(
      `[${networkName}] ${key} missing from deployments.json. ` +
      `Run scripts/bridge/bootstrap-bridged-wrappers.ts first ` +
      `(deploys canonical wrapper via factory, fires TokenCreated event).`,
    );
  }
  console.log(`[${networkName}] reusing ${symbol} wrapper at ${existing}`);
  return { address: existing as `0x${string}` };
}

function envAddress(name: string): `0x${string}` | undefined {
  const v = (process.env[name] ?? "").trim();
  if (!v) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} is not a 20-byte 0x address`);
  return v as `0x${string}`;
}

export async function deployWithdraw(
  usdcWrapper: `0x${string}`,
  usdcMintBase58: string,
) {
  const { viem, networkName } = await hardhat.network.connect();
  // This script never deploys to mainnet: it refuses unless the RPC reports a
  // testnet chain id (lib/testnet-guard.ts). The Rubicon deploy is a separate script
  // (deploy-rubicon-v13.ts); there is no mainnet path in this file.
  await assertTestnetSend(await viem.getPublicClient(), `${networkName} deploy RomeBridgeWithdraw`);
  // Constructor arguments come from lib/withdraw-ctor-args.ts (shared with the Rubicon
  // deploy). forwarder = address(0): the meta-tx paymaster was removed. Nothing is switched
  // on at deploy time: no CCTP domain (the owner runs enable-cctp-domains.ts afterwards) and
  // no Wormhole chain or asset (the owner runs set-wormhole-allowlist.ts). Owner and
  // guardian are fixed in the constructor, so there is no hand-over gap.
  const [deployerWallet] = await viem.getWalletClients();
  // Owner and guardian rules live in lib/deploy-roles.ts (tested): BRIDGE_OWNER, then
  // WORMHOLE_ADMIN, then the deployer; the guardian must differ from the owner.
  const deployerAddress = deployerWallet.account.address as `0x${string}`;
  const roles = resolveRoles({
    network: networkName,
    deployer: deployerAddress,
    bridgeOwner: envAddress("BRIDGE_OWNER"),
    wormholeAdmin: envAddress("WORMHOLE_ADMIN"),
    bridgeGuardian: envAddress("BRIDGE_GUARDIAN"),
  });
  const bridgeOwner = roles.owner as `0x${string}`;
  const bridgeGuardian = roles.guardian as `0x${string}`;
  console.log(`[${networkName}] owner → ${bridgeOwner}; guardian → ${bridgeGuardian === ZERO_ADDRESS ? "(none)" : bridgeGuardian}`);

  const withdraw = await viem.deployContract("RomeBridgeWithdraw", [
    ...buildWithdrawConstructorArgs({ networkName, usdcWrapper, usdcMintBase58, owner: bridgeOwner, guardian: bridgeGuardian }),
  ]);

  console.log(`[${networkName}] RomeBridgeWithdraw → ${withdraw.address}`);

  // Read everything back before it is recorded: a wrong constructor argument
  // (an owner that cannot be zeroed) must stop here, not after the registry
  // has been told about this address.
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const got = {
    version: (await withdraw.read.VERSION()) as string,
    owner: (await withdraw.read.owner()) as string,
    guardian: (await withdraw.read.guardian()) as string,
    domains: (await withdraw.read.cctpDomains()) as readonly number[],
  };
  if (got.version !== "13.0.0") throw new Error(`[${networkName}] VERSION() is ${got.version}, expected 13.0.0`);
  if (!same(got.owner, bridgeOwner)) throw new Error(`[${networkName}] owner() is ${got.owner}, expected ${bridgeOwner}`);
  if (!same(got.guardian, bridgeGuardian)) throw new Error(`[${networkName}] guardian() is ${got.guardian}, expected ${bridgeGuardian}`);
  if (got.domains.length !== 0) throw new Error(`[${networkName}] cctpDomains() is not empty: ${got.domains.join(",")}`);
  console.log(`[${networkName}] read back: VERSION ${got.version}, owner ${got.owner}, guardian ${got.guardian}, no CCTP domain enabled`);
  const d = readDeployments(networkName) as Record<string, any>;
  d["RomeBridgeWithdraw"] = { address: withdraw.address, deployedAt: Math.floor(Date.now() / 1000) };
  writeDeployments(networkName, d as any);

  return withdraw;
}

// -------------------------------------------------------------------------
// Standalone entrypoint
// -------------------------------------------------------------------------

/// Reads `USDC_MINT` from the environment. When it is absent, RomeBridgeWithdraw
/// is skipped.
function readMintEnv(): { usdcMint: string | null } {
  const usdc = (process.env.USDC_MINT ?? "").trim();
  return { usdcMint: usdc.length > 0 ? usdc : null };
}

async function main() {
  const { networkName } = await hardhat.network.connect();

  const { usdcMint } = readMintEnv();
  console.log(`[${networkName}] USDC_MINT=${usdcMint ?? "(unset — RomeBridgeWithdraw skipped)"}`);

  const usdc = usdcMint ? requireExistingWrapper(networkName, "SPL_ERC20_USDC", "wUSDC") : null;

  if (usdc && usdcMint) {
    await deployWithdraw(usdc.address, usdcMint);
    console.log(
      `[${networkName}] No CCTP domain is enabled yet. Next: ` +
      `npx tsx scripts/bridge/enable-cctp-domains.ts --network ${networkName} --domains <list>`,
    );
  } else {
    console.log(
      `[${networkName}] Skipping RomeBridgeWithdraw — USDC_MINT must be set to derive the CCTP PDAs ` +
      `and wire the constructor.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
