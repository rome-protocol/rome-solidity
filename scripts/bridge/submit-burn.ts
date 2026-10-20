// Testnet probe: one burnUSDC(amount, recipient) on the LIVE RomeBridgeWithdraw of
// the selected network (domain 0 must be enabled with enable-cctp-domains.ts).
//
// The recipient is an address the operator controls: the signer's own address by
// default, or BURN_RECIPIENT. The old version burned to 0x...0001 and lost the
// tokens. Refuses unless the RPC reports a testnet chain id (lib/testnet-guard.ts).
//
//   BURN_RECIPIENT  0x... destination address you control (default: the signer)
//   BURN_AMOUNT     base units (default 100000 = 0.1 USDC)
//
//   npx hardhat run scripts/bridge/submit-burn.ts --network hadrian
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
  await assertTestnetSend(pc, `${networkName} submit-burn`);

  const dep = readDeployments(networkName) as Record<string, { address?: string }>;
  const WITHDRAW = dep["RomeBridgeWithdraw"]?.address as `0x${string}` | undefined;
  const RUSDC = dep["SPL_ERC20_USDC"]?.address as `0x${string}` | undefined;
  if (!WITHDRAW || !RUSDC) throw new Error(`[${networkName}] RomeBridgeWithdraw and SPL_ERC20_USDC must be in deployments/${networkName}.json`);

  const deployer = admin.account!.address;
  const recipient = resolveBurnRecipient(deployer, process.env.BURN_RECIPIENT);
  const amount = resolveBurnAmount(process.env.BURN_AMOUNT);
  console.log("From:     ", deployer);
  console.log("Recipient:", recipient, recipient === deployer ? "(the signer: redeemable on the destination)" : "(BURN_RECIPIENT)");
  const rUSDC = await viem.getContractAt("SPL_ERC20", RUSDC);
  const balBefore = await rUSDC.read.balanceOf([deployer]);
  console.log("rUSDC balance before:", balBefore.toString());

  const data = encodeFunctionData({ abi: ABI, functionName: "burnUSDC", args: [amount, recipient] });
  console.log(`Submitting burnUSDC(${amount}, ${recipient}) with 3M gas...`);
  try {
    const hash = await admin.sendTransaction({ to: WITHDRAW, data, gas: 3_000_000n });
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
