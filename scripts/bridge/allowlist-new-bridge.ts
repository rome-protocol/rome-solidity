// One-off: set allowlist entries for burnUSDC + burnETH on the paymaster
// recorded in deployments.json, pointing at the deployed RomeBridgeWithdraw.
//
// Sends as legacy tx with bumped gas — Rome rejects EIP-1559 in some
// configurations, and the paymaster setAllowlistEntry burns more gas than
// the 1M default we tried first.

import { keccak256, toUtf8Bytes } from "ethers";
import hardhat from "hardhat";
import { encodeFunctionData, parseGwei } from "viem";
import { readDeployments } from "../lib/deployments.js";

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [walletClient] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const d = readDeployments(networkName) as Record<string, any>;

  const paymaster = d["RomeBridgePaymaster"]?.address as `0x${string}` | undefined;
  const withdraw = d["RomeBridgeWithdraw"]?.address as `0x${string}` | undefined;
  if (!paymaster || !withdraw) throw new Error("paymaster or withdraw missing in deployments.json");

  const burnUsdcSel = ("0x" + keccak256(toUtf8Bytes("burnUSDC(uint256,address)")).slice(2, 10)) as `0x${string}`;
  const burnEthSel  = ("0x" + keccak256(toUtf8Bytes("burnETH(uint256,address)")).slice(2, 10))  as `0x${string}`;

  const setAllowlistAbi = [{
    type: "function",
    name: "setAllowlistEntry",
    inputs: [
      { name: "target",   type: "address" },
      { name: "selector", type: "bytes4"  },
      { name: "allowed",  type: "bool"    },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  }] as const;

  for (const [label, sel] of [["burnUSDC", burnUsdcSel], ["burnETH", burnEthSel]] as const) {
    const data = encodeFunctionData({ abi: setAllowlistAbi, functionName: "setAllowlistEntry", args: [withdraw, sel, true] });
    const hash = await walletClient.sendTransaction({
      to: paymaster,
      data,
      type: "legacy",
      gas: 50_000_000n,
      gasPrice: parseGwei("100"),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ${label} (${sel}) → ${receipt.status === "success" ? "OK" : "FAILED"} (tx ${hash})`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
