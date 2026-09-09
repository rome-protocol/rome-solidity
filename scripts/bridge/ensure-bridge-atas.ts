// Owner-only rollout step 3 of RomeBridgeWithdraw v10 (rome-solidity #339):
// `ensureBridgeAta(mint)` once per bridged mint, before that mint's first burn.
//
// `transfer_spl_from_ata` has no create leg, so a burn whose bridge ATA is
// missing fails at the CPI. The ATA is created by the HelperProgram from the
// OPERATOR's rent, which is why the call is owner-gated and why this script
// asserts signer == owner() before sending anything.
//
// Idempotent: every mint's ATA is checked on Solana first (existing → skip) and
// read back after the call (still missing → fail loud). Nothing is hand-typed:
// the bridge address comes from deployments/<network>.json, the mints from the
// SPL_ERC20_* wrappers in that file (or BRIDGE_ATA_MINTS), the bridge PDA from
// the HelperProgram's own pda() view.
//
//   BRIDGE_ATA_MINTS   comma-separated base58 mints (default: every bridged wrapper)
//   SOLANA_RPC_URL     read-only Solana RPC for the existence checks (default devnet)
//   DRY_RUN=1          report owner / PDA / per-mint ATA status only; any signer, no writes
//
//   npx hardhat run scripts/bridge/ensure-bridge-atas.ts --network hadrian

import hardhat from "hardhat";
import { Connection, PublicKey } from "@solana/web3.js";
import { readDeployments } from "../lib/deployments.js";
import { base58ToBytes32 } from "../lib/pubkey.js";
import { associatedTokenAddress, bridgedMintsFrom } from "./lib/ensure-bridge-atas.js";

const HELPER_PROGRAM = "0xff00000000000000000000000000000000000009" as const;
const HELPER_PDA_ABI = [
  { type: "function", name: "pda", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "bytes32" }] },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ataExists(conn: Connection, ata: PublicKey): Promise<boolean> {
  return (await conn.getAccountInfo(ata, "confirmed")) !== null;
}

async function main() {
  const { viem, networkName } = await hardhat.network.connect();
  const [signer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  const d = readDeployments(networkName) as unknown as Record<string, unknown>;
  const withdrawAddr = (d["RomeBridgeWithdraw"] as { address?: string } | undefined)?.address as `0x${string}` | undefined;
  if (!withdrawAddr) {
    throw new Error(`[${networkName}] no RomeBridgeWithdraw in deployments/${networkName}.json — deploy it first`);
  }
  const mints = bridgedMintsFrom(d, process.env.BRIDGE_ATA_MINTS);

  const withdraw = await viem.getContractAt("RomeBridgeWithdraw", withdrawAddr);
  const owner = (await withdraw.read.owner()) as `0x${string}`;
  const me = signer.account.address;
  console.log(`[${networkName}] RomeBridgeWithdraw ${withdrawAddr}`);
  console.log(`[${networkName}] owner=${owner} signer=${me}`);
  const dryRun = process.env.DRY_RUN === "1";
  if (!dryRun && owner.toLowerCase() !== me.toLowerCase()) {
    throw new Error(`signer ${me} is not the owner ${owner} — ensureBridgeAta is onlyOwner.`);
  }

  const pdaHex = (await publicClient.readContract({
    address: HELPER_PROGRAM,
    abi: HELPER_PDA_ABI,
    functionName: "pda",
    args: [withdrawAddr],
  })) as `0x${string}`;
  const bridgePda = new PublicKey(Buffer.from(pdaHex.slice(2), "hex"));
  const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
  const lamports = await conn.getBalance(bridgePda, "confirmed");
  console.log(`[${networkName}] bridge PDA ${bridgePda.toBase58()} — ${lamports} lamports`);
  if (lamports === 0) {
    // Rollout step 2 is a separate, Solana-side transfer; say it plainly rather than let the first burn discover it.
    console.log(`[${networkName}] WARNING: bridge PDA holds 0 lamports — burns need it funded above the quote-time floor (rollout step 2).`);
  }

  let created = 0;
  for (const { mint, symbol } of mints) {
    const ata = associatedTokenAddress(bridgePda, new PublicKey(mint));
    if (await ataExists(conn, ata)) {
      console.log(`[${networkName}] ${symbol} (${mint}) — bridge ATA ${ata.toBase58()} exists — skip`);
      continue;
    }
    if (dryRun) {
      console.log(`[${networkName}] ${symbol} (${mint}) — bridge ATA ${ata.toBase58()} MISSING — would call ensureBridgeAta (dry run)`);
      continue;
    }
    console.log(`[${networkName}] ${symbol} (${mint}) — ensureBridgeAta …`);
    const hash = await withdraw.write.ensureBridgeAta([base58ToBytes32(mint)]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`ensureBridgeAta(${symbol}) reverted — tx ${hash}`);
    }
    let seen = false;
    for (let i = 0; i < 12 && !seen; i++) {
      await sleep(2500);
      seen = await ataExists(conn, ata);
    }
    if (!seen) {
      throw new Error(`verify failed: bridge ATA ${ata.toBase58()} for ${symbol} still missing on Solana after tx ${hash}`);
    }
    created++;
    console.log(`[${networkName}]   ✓ ${symbol} bridge ATA ${ata.toBase58()} created (tx ${hash})`);
  }
  console.log(`[${networkName}] ensure-bridge-atas ${dryRun ? "dry run" : "complete"} — ${created} created, ${mints.length - created} ${dryRun ? "checked" : "already present"}.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
