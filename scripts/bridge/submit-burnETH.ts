import hardhat from "hardhat";
import fs from "node:fs";
const dep = JSON.parse(fs.readFileSync("deployments/rome.json", "utf8"));
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

  // burnETH signs as the bridge itself now (direct CALL into the mutating
  // precompile track, not a delegatecall borrowing the caller's PDA), so it
  // pulls from the bridge's own ATA rather than the user's. Precondition:
  // an SPL-level delegate grant straight to 0xff..09 — a bridge-mediated
  // approveBurnETH tx no longer exists.
  const { keccak256, toUtf8Bytes } = await import("ethers");
  const HELPER_PROGRAM_ADDRESS = "0xff00000000000000000000000000000000000009";
  const approveSplSel = "0x" + keccak256(toUtf8Bytes("approve_spl(address,uint64,bytes32)")).slice(2, 10);
  const burnSel = "0x" + keccak256(toUtf8Bytes("burnETH(uint256,address)")).slice(2, 10);
  const mintId: `0x${string}` = await rETH.read.mint_id();
  console.log("approve_spl selector:", approveSplSel);
  console.log("burnETH selector:", burnSel);

  console.log("\nTX 1: approve_spl(bridge, amount, mint) direct to 0xff..09…");
  const approveData = approveSplSel +
    WITHDRAW.slice(2).toLowerCase().padStart(64, "0") +
    amount.toString(16).padStart(64, "0") +
    mintId.slice(2).padStart(64, "0");
  const hash1 = await admin.sendTransaction({
    to: HELPER_PROGRAM_ADDRESS, data: approveData as `0x${string}`, gas: 3_000_000n,
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
  const sigRes = await fetch("https://rome.devnet.romeprotocol.xyz/", {
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
