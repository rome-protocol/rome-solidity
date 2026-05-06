// Marcus → Solana: bridge a wrapper SPL token out to a Solana wallet.
// Uses wrapper.ensureRecipientAta (idempotent ATA-create) then bridgeOutToSolana.

import hardhat from "hardhat";
import { encodeFunctionData, parseAbi, parseGwei } from "viem";
import { PublicKey } from "@solana/web3.js";
import { readDeployments } from "../lib/deployments.js";

// Send to my own deployer-controlled Solana keypair (mainnet/devnet) for trace-back.
// Using a well-known Solana wallet pubkey for visibility:
const SOLANA_RECIPIENT_BASE58 = "AVqgWKZ8U6P2nKkw2PQVw3z6unJ2W9JKmPYoSXjpkx2L";

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [walletClient] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const d = readDeployments(networkName) as Record<string, any>;
  const wusdc = d["SPL_ERC20_USDC"]?.address as `0x${string}`;

  const recipient32 = new PublicKey(SOLANA_RECIPIENT_BASE58).toBuffer();
  const recipientHex = ("0x" + recipient32.toString("hex")) as `0x${string}`;

  const send = async (label: string, to: `0x${string}`, data: `0x${string}`) => {
    try {
      const hash = await walletClient.sendTransaction({
        to, data, type: "legacy", gas: 50_000_000n, gasPrice: parseGwei("1"),
      });
      const r = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`  ${label}: ${r.status} (gas ${r.gasUsed}, tx ${hash})`);
      return r.status === "success";
    } catch (e: any) {
      const detail = (e?.cause?.details ?? e?.shortMessage ?? String(e)).slice(0, 250);
      console.log(`  ${label}: FAILED — ${detail}`);
      return false;
    }
  };

  console.log(`Bridging WUSDC out to Solana wallet ${SOLANA_RECIPIENT_BASE58}`);
  console.log(`WUSDC wrapper: ${wusdc}`);

  console.log(`\n=== Step 1: ensureRecipientAta ===`);
  const ensureData = encodeFunctionData({
    abi: parseAbi(["function ensureRecipientAta(bytes32) returns (bytes32)"]),
    functionName: "ensureRecipientAta",
    args: [recipientHex],
  });
  const ok1 = await send("wrapper.ensureRecipientAta", wusdc, ensureData);
  if (!ok1) { console.log("ensure failed; aborting"); return; }

  console.log(`\n=== Step 2: bridgeOutToSolana(recipient, 100 base units = 0.0001 USDC) ===`);
  const bridgeData = encodeFunctionData({
    abi: parseAbi(["function bridgeOutToSolana(bytes32,uint256) returns (bool)"]),
    functionName: "bridgeOutToSolana",
    args: [recipientHex, 100n],
  });
  await send("wrapper.bridgeOutToSolana", wusdc, bridgeData);
}

main().catch(e => { console.error(e); process.exit(1); });
