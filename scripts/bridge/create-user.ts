// One-off: call factory.create_user() to bootstrap the deployer's
// unified user PDA on the new factory. Topup-from-operator covers the
// 50M-lamport CREATE_PAYER_LAMPORTS budget.

import hardhat from "hardhat";
import { encodeFunctionData, parseGwei } from "viem";
import { readDeployments } from "../lib/deployments.js";

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [walletClient] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const d = readDeployments(networkName) as Record<string, any>;
  const factory = d["ERC20SPLFactory"]?.address as `0x${string}` | undefined;
  if (!factory) throw new Error("ERC20SPLFactory missing in deployments.json");

  const data = encodeFunctionData({
    abi: [{ type: "function", name: "create_user", inputs: [], outputs: [], stateMutability: "nonpayable" }],
    functionName: "create_user",
    args: [],
  });
  const hash = await walletClient.sendTransaction({
    to: factory,
    data,
    type: "legacy",
    gas: 100_000_000n,
    gasPrice: parseGwei("100"),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`factory.create_user → ${receipt.status} (tx ${hash})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
