// Testnet probe: one burnUSDC(amount, recipient) with a fixed gas limit, against
// the LIVE RomeBridgeWithdraw of the selected network (domain 0 enabled).
//
// The recipient is an address the operator controls: the signer's own address by
// default, or BURN_RECIPIENT. The old version burned to 0x...0001 and lost the
// tokens. Refuses unless the RPC reports a testnet chain id (lib/testnet-guard.ts).
//
//   BURN_RECIPIENT  0x... destination address you control (default: the signer)
//   BURN_AMOUNT     base units (default 100000 = 0.1 USDC)
//
//   npx hardhat run scripts/bridge/try-burn.ts --network hadrian
import hardhat from "hardhat";
import { encodeFunctionData, parseAbi } from "viem";
import { readDeployments } from "../lib/deployments.js";
import { resolveBurnAmount, resolveBurnRecipient } from "./lib/burn-recipient.js";
import { assertTestnetSend } from "./lib/testnet-guard.js";

const ABI = parseAbi(["function burnUSDC(uint256 amount, address ethereumRecipient)"]);

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [admin] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  await assertTestnetSend(pc, `${networkName} try-burn`);

  const dep = readDeployments(networkName) as Record<string, { address?: string }>;
  const WITHDRAW = dep["RomeBridgeWithdraw"]?.address as `0x${string}` | undefined;
  if (!WITHDRAW) throw new Error(`[${networkName}] no RomeBridgeWithdraw in deployments/${networkName}.json`);

  const recipient = resolveBurnRecipient(admin.account!.address, process.env.BURN_RECIPIENT);
  const amount = resolveBurnAmount(process.env.BURN_AMOUNT);
  console.log(`Recipient: ${recipient}${recipient === admin.account!.address ? " (the signer)" : " (BURN_RECIPIENT)"}`);
  const data = encodeFunctionData({ abi: ABI, functionName: "burnUSDC", args: [amount, recipient] });
  console.log("Submitting burnUSDC tx with hardcoded gas...");
  try {
    const hash = await admin.sendTransaction({ to: WITHDRAW, data, gas: 3_000_000n });
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
