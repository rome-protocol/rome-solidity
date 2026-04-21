import hardhat from "hardhat";
import fs from "node:fs";
const dep = JSON.parse(fs.readFileSync("deployments/marcus.json", "utf8"));
const WITHDRAW = dep.RomeBridgeWithdraw.address as `0x${string}`;
const RETH = dep.SPL_ERC20_WETH.address as `0x${string}`;
async function main() {
  const { viem } = await hardhat.network.connect();
  const [admin] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const deployer = admin.account!.address;
  console.log("From:", deployer);
  const rETH = await viem.getContractAt("SPL_ERC20", RETH);
  const balBefore = await rETH.read.balanceOf([deployer]);
  console.log("rETH balance before:", balBefore.toString());

  // burnETH(uint256 amount, address ethereumRecipient) -> selector 0xc150c88d
  // 1000 base units = 0.00001 wETH (small test)
  const amount = 1000n;
  const recipient = deployer; // non-zero recipient
  const data = "0xc150c88d" +
    amount.toString(16).padStart(64, "0") +
    recipient.toLowerCase().replace("0x", "").padStart(64, "0");
  console.log("Data:", data);
  console.log("Submitting burnETH tx with 3M gas (skipping eth_call — StaticModeViolation in emulator)...");
  try {
    const hash = await admin.sendTransaction({
      to: WITHDRAW, data: data as `0x${string}`, gas: 3_000_000n,
    });
    console.log("TX:", hash);
    const rcpt = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
    console.log("Status:", rcpt.status, "gasUsed:", rcpt.gasUsed.toString());
    for (const log of rcpt.logs) console.log("  topic0:", log.topics?.[0]);
  } catch (e: any) {
    console.log("Submit error:", e.shortMessage || e.message);
    if (e.cause) console.log("  cause:", e.cause.shortMessage || e.cause.message);
  }
  const balAfter = await rETH.read.balanceOf([deployer]);
  console.log("rETH balance after:", balAfter.toString());
}
main().catch(e => { console.error(e); process.exit(1); });
