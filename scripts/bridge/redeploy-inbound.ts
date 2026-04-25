// scripts/bridge/redeploy-inbound.ts
//
// Redeploys ONLY RomeBridgeInbound — for picking up the security hardening
// shipped in rome-solidity #55 (ReentrancyGuard on settleInbound + slippage
// check after unwrap_spl_to_gas).
//
// Why inbound-only and not paymaster:
//   The paymaster #55 changes (Pausable + mutable sponsoredTxCap) are also
//   useful but redeploying the paymaster cascades to RomeBridgeWithdraw +
//   RomeBridgeInbound because both store the forwarder as an immutable
//   ERC2771Context field. The reentrancy + slippage fixes are the
//   security-critical part; ship those first, redeploy the paymaster
//   later if Pausable becomes load-bearing.
//
// What this script does:
//   1. Reads current RomeBridgeInbound + RomeBridgePaymaster + SPL_ERC20_USDC
//      from deployments/<network>.json.
//   2. Archives the current RomeBridgeInbound under
//      archive.RomeBridgeInboundPrevious (so we can roll back).
//   3. Deploys a new RomeBridgeInbound against the SAME paymaster + wrapper.
//   4. Re-runs the paymaster allowlist for the new inbound's settleInbound
//      selector (the existing entry points at the old address — leaves it
//      in place, but the new entry is what the worker will use).
//   5. Writes the new address back to deployments/<network>.json.
//
// Idempotent in the weak sense: if you re-run, you get a fresh deploy each
// time and overwrite archive.RomeBridgeInboundPrevious with whatever was
// "current" at the start of this run. Don't run twice without good reason.
//
// Usage:
//   npx hardhat run scripts/bridge/redeploy-inbound.ts --network monti_spl
//   npx hardhat run scripts/bridge/redeploy-inbound.ts --network local

import hardhat from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { keccak256, toUtf8Bytes, getAddress } from "ethers";
import { PublicKey } from "@solana/web3.js";

function deploymentsPath(networkName: string): string {
  return path.resolve(process.cwd(), "deployments", `${networkName}.json`);
}

function readDeps(networkName: string): Record<string, any> {
  const p = deploymentsPath(networkName);
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeDeps(networkName: string, data: Record<string, any>): void {
  fs.writeFileSync(deploymentsPath(networkName), JSON.stringify(data, null, 2) + "\n");
}

async function main() {
  const conn = await hardhat.network.connect();
  const viem = (conn as any).viem;
  const networkName = (conn as any).networkName ?? "unknown";
  const [deployer] = await viem.getWalletClients();

  console.log("Network: ", networkName);
  console.log("Deployer:", deployer.account.address);

  const deps = readDeps(networkName);
  const paymasterAddr = deps.RomeBridgePaymaster?.address as `0x${string}` | undefined;
  const usdcWrapperAddr = deps.SPL_ERC20_USDC?.address as `0x${string}` | undefined;
  const usdcMintBase58 = deps.SPL_ERC20_USDC?.mintId as string | undefined;
  const oldInboundAddr = deps.RomeBridgeInbound?.address as `0x${string}` | undefined;

  if (!paymasterAddr) throw new Error("RomeBridgePaymaster missing from deployments — run scripts/bridge/deploy.ts first");
  if (!usdcWrapperAddr) throw new Error("SPL_ERC20_USDC missing from deployments — run scripts/bridge/deploy.ts first");
  if (!usdcMintBase58) throw new Error("SPL_ERC20_USDC.mintId missing from deployments");
  if (!oldInboundAddr) {
    console.log("No existing RomeBridgeInbound recorded — running a fresh deploy via deploy-inbound.ts is more appropriate.");
    process.exit(1);
  }

  console.log("\nReusing:");
  console.log("  RomeBridgePaymaster: ", paymasterAddr);
  console.log("  SPL_ERC20_USDC:      ", usdcWrapperAddr);
  console.log("  USDC mint (b58):     ", usdcMintBase58);
  console.log("\nReplacing:");
  console.log("  RomeBridgeInbound (old):", oldInboundAddr);

  const mintBytes32 = ("0x" +
    Buffer.from(new PublicKey(usdcMintBase58).toBytes()).toString("hex")) as `0x${string}`;

  console.log("\nDeploying new RomeBridgeInbound (PR #55 hardening)…");
  const inbound = await viem.deployContract("RomeBridgeInbound", [
    paymasterAddr,
    usdcWrapperAddr,
    mintBytes32,
  ]);
  const newInboundAddr = getAddress(inbound.address) as `0x${string}`;
  console.log("  RomeBridgeInbound (new):", newInboundAddr);

  // Archive old, write new.
  if (!deps.archive) deps.archive = {};
  deps.archive.RomeBridgeInboundPrevious = {
    address: oldInboundAddr,
    archivedAt: Math.floor(Date.now() / 1000),
  };
  deps.RomeBridgeInbound = {
    address: newInboundAddr,
    deployedAt: Math.floor(Date.now() / 1000),
  };
  writeDeps(networkName, deps);
  console.log(`  Wrote ${deploymentsPath(networkName)}`);

  // Allowlist the new inbound's settleInbound on the paymaster.
  // The old (RomeBridgeInbound, settleInbound) entry stays in place — harmless,
  // and lets in-flight bridges that signed against the old address still work
  // until their TTL expires. The worker will start signing against the new
  // address once chains.yaml is updated.
  const paymaster = await viem.getContractAt("RomeBridgePaymaster", paymasterAddr);
  const settleSel = ("0x" +
    keccak256(toUtf8Bytes("settleInbound(uint256)")).slice(2, 10)) as `0x${string}`;

  const already = (await paymaster.read.allowlist([newInboundAddr, settleSel])) as boolean;
  if (already) {
    console.log("  Allowlist already set: RomeBridgeInbound.settleInbound — skipping");
  } else {
    const tx = await paymaster.write.setAllowlistEntry([newInboundAddr, settleSel, true]);
    console.log("  Allowlisted RomeBridgeInbound.settleInbound on paymaster");
    console.log("  tx:", tx);
  }

  console.log("\n== Summary ==");
  console.log("  RomeBridgeInbound (new):", newInboundAddr);
  console.log("  Old (archived):         ", oldInboundAddr);
  console.log("\n== Manual follow-ups (rome-ui) ==");
  console.log("  1. rome-ui/deploy/chains.sample.yaml — update marcus.contracts.romeBridgeInbound");
  console.log("  2. rome-ui/backend/chains.yaml (operator-local, gitignored) — same field");
  console.log("  3. (Optional) rome-ui/src/server/bridge/flows/inboundCctp.ts — only if MARCUS_PAYMASTER_ADDRESS env var fallback also changed (not in this redeploy)");
  console.log("  4. Restart rome-ui backend so it re-reads chains.yaml");
  console.log("  5. See scripts/bridge/REDEPLOY_HARDENING.md for the full runbook.");
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
