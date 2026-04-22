// One-shot: allowlist approveBurnETH(uint256) on the paymaster for the current
// RomeBridgeWithdraw so ERC-2771 meta-tx support is complete for the
// two-step outbound Wormhole flow.
import hardhat from "hardhat";
import fs from "node:fs";
import { keccak256, toUtf8Bytes } from "ethers";

async function main() {
  const { viem } = await hardhat.network.connect();
  const dep = JSON.parse(fs.readFileSync("deployments/marcus.json", "utf8"));
  const paymaster = await viem.getContractAt("RomeBridgePaymaster", dep.RomeBridgePaymaster.address);
  const withdraw = dep.RomeBridgeWithdraw.address as `0x${string}`;
  const sel = ("0x" + keccak256(toUtf8Bytes("approveBurnETH(uint256)")).slice(2, 10)) as `0x${string}`;
  console.log("Allowlisting:");
  console.log("  target:  ", withdraw);
  console.log("  selector:", sel, "(approveBurnETH(uint256))");
  const hash = await paymaster.write.setAllowlistEntry([withdraw, sel, true]);
  console.log("  tx:", hash);
}
main().catch(e => console.error(e.message || e));
