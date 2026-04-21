import hardhat from "hardhat";
async function main() {
  const { viem } = await hardhat.network.connect();
  const [admin] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const fs = await import("node:fs");
  const dep = JSON.parse(fs.readFileSync("deployments/marcus.json", "utf8"));
  const WITHDRAW = dep.RomeBridgeWithdraw.address as `0x${string}`;
  const RUSDC = "0x6ed2944bba4cb5b1cb295541f315c648658dd67c" as const;
  const deployer = admin.account!.address;
  console.log("From:", deployer);
  const rUSDC = await viem.getContractAt("SPL_ERC20", RUSDC);
  const balBefore = await rUSDC.read.balanceOf([deployer]);
  console.log("rUSDC balance before:", balBefore.toString());

  const data = "0x259acd3b" +
    (100000n).toString(16).padStart(64, "0") +
    "0000000000000000000000000000000000000000000000000000000000000001";
  console.log("Submitting burnUSDC(100000, 0x0001) tx with 3M gas...");
  try {
    const hash = await admin.sendTransaction({
      to: WITHDRAW, data: data as `0x${string}`, gas: 3_000_000n,
    });
    console.log("TX:", hash);
    console.log("Waiting for receipt...");
    const rcpt = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
    console.log("Status:", rcpt.status, "gasUsed:", rcpt.gasUsed.toString());
    console.log("Logs:", rcpt.logs.length);
    for (const log of rcpt.logs) {
      console.log("  topic0:", log.topics?.[0]);
    }
  } catch (e: any) {
    console.log("Submit error:", e.shortMessage || e.message);
    if (e.cause) console.log("  cause:", e.cause.shortMessage || e.cause.message);
  }
  const balAfter = await rUSDC.read.balanceOf([deployer]);
  console.log("rUSDC balance after:", balAfter.toString());
}
main().catch(e => { console.error(e); process.exit(1); });
