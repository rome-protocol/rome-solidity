import hardhat from "hardhat";
import { readDeployments } from "../lib/deployments.js";
import { base58ToBytes32 } from "../lib/pubkey.js";
const CPI = "0xFF00000000000000000000000000000000000008" as const;
// Devnet default; mainnet runs must pass the canonical Wormhole wETH mint
// (7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs) via the env var.
const WETH_MINT = process.env.WETH_MINT ?? "6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs";
async function main() {
  const { viem, networkName } = (await hardhat.network.connect()) as unknown as {
    viem: { getWalletClients: () => Promise<Array<{ account?: { address: `0x${string}` } }>>; deployContract: (n: "SPL_ERC20", a: readonly [`0x${string}`,`0x${string}`,string,string,`0x${string}`]) => Promise<{ address: `0x${string}` }>; };
    networkName: string;
  };
  const [admin] = await viem.getWalletClients();
  if (!admin?.account) throw new Error("no deployer");
  const d = readDeployments(networkName) as Record<string, { address?: `0x${string}` }>;
  const usersAddr = d["ERC20Users"]?.address;
  const mint = base58ToBytes32(WETH_MINT) as `0x${string}`;
  const w = await viem.deployContract("SPL_ERC20", [mint, CPI, "Rome WETH (v9 ensureRecipientAta)", "WETHv9", usersAddr!]);
  console.log("=== DEPLOYED WETH v9 ===");
  console.log(`Address: ${w.address}`);
}
main().catch(e => { console.error(e); process.exit(1); });
