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
  console.log("Withdraw:", WITHDRAW);

  const rETH = await viem.getContractAt("SPL_ERC20", RETH);
  const balBefore = await rETH.read.balanceOf([deployer]);
  console.log("rETH balance before:", balBefore.toString());
  const amount = balBefore / 2n;
  if (amount === 0n) throw new Error("no rETH");

  // approveBurnETH(uint256 amount) -> selector = keccak("approveBurnETH(uint256)")[0:4]
  // compute via ethers
  const { keccak256, toUtf8Bytes } = await import("ethers");
  const approveSel = "0x" + keccak256(toUtf8Bytes("approveBurnETH(uint256)")).slice(2, 10);
  const burnSel    = "0x" + keccak256(toUtf8Bytes("burnETH(uint256,address)")).slice(2, 10);
  console.log("approveBurnETH selector:", approveSel);
  console.log("burnETH selector:", burnSel);

  console.log("\nTX 1: approveBurnETH(amount)…");
  const approveData = approveSel + amount.toString(16).padStart(64, "0");
  const hash1 = await admin.sendTransaction({
    to: WITHDRAW, data: approveData as `0x${string}`, gas: 3_000_000n,
  });
  console.log("  TX:", hash1);
  const rcpt1 = await pc.waitForTransactionReceipt({ hash: hash1, timeout: 120_000 });
  console.log("  Status:", rcpt1.status);
  if (rcpt1.status !== "success") {
    console.log("  approve failed — aborting");
    return;
  }

  console.log("\nTX 2: burnETH(amount, recipient)…");
  const burnData = burnSel +
    amount.toString(16).padStart(64, "0") +
    deployer.slice(2).toLowerCase().padStart(64, "0");
  const hash2 = await admin.sendTransaction({
    to: WITHDRAW, data: burnData as `0x${string}`, gas: 3_000_000n,
  });
  console.log("  TX:", hash2);
  const rcpt2 = await pc.waitForTransactionReceipt({ hash: hash2, timeout: 120_000 });
  console.log("  Status:", rcpt2.status, "gasUsed:", rcpt2.gasUsed.toString());
  for (const log of rcpt2.logs) console.log("    topic0:", log.topics?.[0]);

  const balAfter = await rETH.read.balanceOf([deployer]);
  console.log("rETH balance after:", balAfter.toString());

  // Look up Solana sig for the burn tx
  const sigRes = await fetch("https://marcus.devnet.romeprotocol.xyz/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "rome_solanaTxForEvmTx",
      params: [hash2],
    }),
  });
  console.log("\nSolana sigs for burnETH:", JSON.stringify(await sigRes.json(), null, 2));
}
main().catch(e => console.error(e.message || e));
