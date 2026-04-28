import hardhat from "hardhat";
import { readDeployments } from "../lib/deployments.js";
import { base58ToBytes32 } from "../lib/pubkey.js";
const CPI = "0xFF00000000000000000000000000000000000008" as const;
const WSOL_MINT = "So11111111111111111111111111111111111111112";
async function main() {
  const { viem, networkName } = (await hardhat.network.connect()) as unknown as {
    viem: { getWalletClients: () => Promise<Array<{ account?: { address: `0x${string}` } }>>; deployContract: (n: "SPL_ERC20", a: readonly [`0x${string}`,`0x${string}`,string,string,`0x${string}`]) => Promise<{ address: `0x${string}` }>; };
    networkName: string;
  };
  const [admin] = await viem.getWalletClients();
  if (!admin?.account) throw new Error("no deployer");
  const d = readDeployments(networkName) as Record<string, { address?: `0x${string}` }>;
  const usersAddr = d["ERC20Users"]?.address;
  if (!usersAddr) throw new Error("ERC20Users missing");
  const mint = base58ToBytes32(WSOL_MINT) as `0x${string}`;
  const w = await viem.deployContract("SPL_ERC20", [mint, CPI, "Rome WSOL (v9 ensureRecipientAta)", "WSOLv9", usersAddr]);
  console.log("=== DEPLOYED WSOL v9 ===");
  console.log(`Address: ${w.address}`);
}
main().catch(e => { console.error(e); process.exit(1); });
