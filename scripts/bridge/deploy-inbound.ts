// scripts/bridge/deploy-inbound.ts
//
// Deploy RomeBridgeInbound to marcus (or any configured network) and wire
// it into the existing paymaster. Symmetric to the outbound RomeBridgeWithdraw
// deployment; reads the already-deployed RomeBridgePaymaster + SPL_ERC20_USDC
// addresses from deployments/<network>.json.
//
// After deployment:
//   1. The RomeBridgeInbound address is written back to <network>.json.
//   2. The paymaster's allowlist is updated to accept two (target, selector)
//      pairs needed for inbound gas-split:
//        (SPL_ERC20_USDC, approve.selector)       — user authorises inbound
//        (RomeBridgeInbound, settleInbound.selector) — user invokes unwrap
//      See scripts/bridge/allowlist-approve-selector.ts for the outbound
//      companion.
//
// Usage:
//   npx hardhat run scripts/bridge/deploy-inbound.ts --network monti_spl
//   npx hardhat run scripts/bridge/deploy-inbound.ts --network local
//
// Idempotent: if RomeBridgeInbound is already in deployments, the script
// skips the deploy but still re-runs the allowlist step (harmless if the
// selectors are already set — the contract short-circuits).

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
  console.log("Network:", networkName);
  console.log("Deployer:", deployer.account.address);

  const deps = readDeps(networkName);
  const paymasterAddr = deps.RomeBridgePaymaster?.address as `0x${string}` | undefined;
  const usdcWrapperAddr = deps.SPL_ERC20_USDC?.address as `0x${string}` | undefined;
  const usdcMintBase58 = deps.SPL_ERC20_USDC?.mintId as string | undefined;

  if (!paymasterAddr) throw new Error("RomeBridgePaymaster address missing from deployments — deploy it first");
  if (!usdcWrapperAddr) throw new Error("SPL_ERC20_USDC address missing from deployments — deploy it first");
  if (!usdcMintBase58) throw new Error("SPL_ERC20_USDC.mintId missing from deployments");

  console.log("Paymaster:      ", paymasterAddr);
  console.log("USDC wrapper:   ", usdcWrapperAddr);
  console.log("USDC mint (b58):", usdcMintBase58);

  // Convert base58 Solana pubkey to bytes32 hex — the contract takes the
  // mint as bytes32 so it can emit structured SettledInbound events.
  const mintBytes32 = ("0x" +
    Buffer.from(new PublicKey(usdcMintBase58).toBytes()).toString("hex")) as `0x${string}`;
  console.log("USDC mint (hex):", mintBytes32);

  // -----------------------------------------------------------------
  // 1. Deploy (or reuse) RomeBridgeInbound
  // -----------------------------------------------------------------
  let inboundAddr = deps.RomeBridgeInbound?.address as `0x${string}` | undefined;
  if (inboundAddr) {
    console.log("RomeBridgeInbound already deployed:", inboundAddr, "— skipping deploy");
  } else {
    console.log("Deploying RomeBridgeInbound…");
    const inbound = await viem.deployContract("RomeBridgeInbound", [
      paymasterAddr,    // forwarder (ERC2771Context)
      usdcWrapperAddr,  // wrapper (cast to SPL_ERC20)
      mintBytes32,      // mint
    ]);
    inboundAddr = getAddress(inbound.address) as `0x${string}`;
    console.log("RomeBridgeInbound deployed:", inboundAddr);
    const next = {
      ...deps,
      RomeBridgeInbound: {
        address: inboundAddr,
        deployedAt: Math.floor(Date.now() / 1000),
      },
    };
    writeDeps(networkName, next);
    console.log(`Wrote ${deploymentsPath(networkName)}`);
  }

  // -----------------------------------------------------------------
  // 2. Update paymaster allowlist so the relayed calls can go through
  // -----------------------------------------------------------------
  const paymaster = await viem.getContractAt("RomeBridgePaymaster", paymasterAddr);
  const approveSel = ("0x" +
    keccak256(toUtf8Bytes("approve(address,uint256)")).slice(2, 10)) as `0x${string}`;
  const settleSel = ("0x" +
    keccak256(toUtf8Bytes("settleInbound(uint256)")).slice(2, 10)) as `0x${string}`;

  const pairs: Array<{ target: `0x${string}`; sel: `0x${string}`; label: string }> = [
    { target: usdcWrapperAddr, sel: approveSel, label: "SPL_ERC20_USDC.approve" },
    { target: inboundAddr!,    sel: settleSel,  label: "RomeBridgeInbound.settleInbound" },
  ];

  for (const { target, sel, label } of pairs) {
    const already = (await paymaster.read.allowlist([target, sel])) as boolean;
    if (already) {
      console.log(`Allowlist already set: ${label} (${target}:${sel}) — skipping`);
      continue;
    }
    const tx = await paymaster.write.setAllowlistEntry([target, sel, true]);
    console.log(`Allowlisted ${label}: ${target}:${sel}`);
    console.log("  tx:", tx);
  }

  console.log("\n== Summary ==");
  console.log("  RomeBridgeInbound:       ", inboundAddr);
  console.log("  Paymaster allowlist:     approve + settleInbound ✓");
  console.log("\n== Next steps (rome-ui wiring) ==");
  console.log("  1. Add 'romeBridgeInbound' + 'romeBridgePaymaster' to chain config");
  console.log("     (src/constants/chains.ts contracts + src/lib/config/chains.ts normalizer).");
  console.log("  2. Backend /api/chains should surface both via chains.yaml.");
  console.log("  3. UI bridge form: when gasAmount > 0, collect 2 EIP-712 ForwardRequest signatures:");
  console.log("       (a) wrapper.approve(romeBridgeInbound, gasAmount)");
  console.log("       (b) romeBridgeInbound.settleInbound(gasAmount)");
  console.log("  4. POST them alongside the bridge registration.");
  console.log("  5. Worker `settling-split` phase: paymaster.executeBatch([a, b]).");
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
