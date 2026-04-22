import hardhat from "hardhat";
async function main() {
  const { viem } = await hardhat.network.connect();
  const [admin] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const WITHDRAW = "0x924726a02a6cf27f10904442fd2199a5b5e81a25" as const;
  const recipient = "0x0000000000000000000000000000000000000001" as const;
  const amount = 100000n;  // 0.1 USDC at 6 decimals
  const data = ("0x259acd3b" +
    amount.toString(16).padStart(64, "0") +
    recipient.slice(2).padStart(64, "0")) as `0x${string}`;
  console.log("Submitting burnUSDC tx with hardcoded gas...");
  try {
    const hash = await admin.sendTransaction({
      to: WITHDRAW, data, gas: 3_000_000n,
    });
    console.log("tx hash:", hash);
    const rcpt = await pc.waitForTransactionReceipt({ hash, timeout: 60_000 });
    console.log("status:", rcpt.status, "gasUsed:", rcpt.gasUsed);
    console.log("logs:", rcpt.logs.length);
    for (const log of rcpt.logs) console.log("  ", log.topics?.[0], log.data?.slice(0, 80));
  } catch (e: any) {
    console.log("submit failed:", e.shortMessage || e.message || String(e));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
