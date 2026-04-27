import hardhat from "hardhat";
import fs from "node:fs";
import { keccak256, toUtf8Bytes } from "ethers";

async function main() {
  const { viem } = await hardhat.network.connect();
  const [a] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const deployer = a.account!.address;
  const d = JSON.parse(fs.readFileSync("deployments/marcus.json", "utf8"));
  const RETH = d.SPL_ERC20_WETH.address;
  const WITHDRAW = d.RomeBridgeWithdraw.address;
  console.log("rETH:", RETH);
  console.log("withdraw:", WITHDRAW);
  const users = await viem.getContractAt("ERC20Users", "0x803f6923bcc776db1d0aa6fcdbd8ceddf35ad6f3");
  const rETH = await viem.getContractAt("SPL_ERC20", RETH);
  try { await users.write.ensure_user([deployer]); } catch {}
  try { const tx = await rETH.write.ensure_token_account([deployer]); await pc.waitForTransactionReceipt({ hash: tx, timeout: 60_000 }); } catch (e: any) { console.log("ensure_ta err:", (e.shortMessage || e.message).slice(0, 160)); }
  const bal = await rETH.read.balanceOf([deployer]);
  console.log("rETH balance:", bal.toString());
  // burnETH(bal/2, deployer)
  const amt = bal / 2n;
  const data = ("0xc150c88d" + amt.toString(16).padStart(64, "0") + deployer.slice(2).toLowerCase().padStart(64, "0")) as `0x${string}`;
  try {
    const hash = await a.sendTransaction({ to: WITHDRAW as `0x${string}`, data, gas: 3_000_000n });
    console.log("burnETH tx:", hash);
    const rcpt = await pc.waitForTransactionReceipt({ hash, timeout: 60_000 });
    console.log("Status:", rcpt.status, "Logs:", rcpt.logs.length);
    for (const log of rcpt.logs) console.log("  topic0:", log.topics?.[0]);
  } catch (e: any) {
    console.log("burnETH err:", (e.shortMessage || e.message).slice(0, 200));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
