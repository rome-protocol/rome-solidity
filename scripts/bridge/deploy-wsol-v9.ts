import hardhat from "hardhat";
import { assertTestnetSend } from "./lib/testnet-guard.js";
import { readDeployments } from "../lib/deployments.js";
import { assertDirectWrapperDeployAllowed } from "../lib/wrapper-factory.js";
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
  // No wrapper is deployed directly on a chain where the named wrapper factory (E1) is live.
  assertDirectWrapperDeployAllowed(networkName, "deploy a wrapper directly (deploy-wsol-v9)");
  await assertTestnetSend(await (viem as any).getPublicClient(), `${networkName} deploy-wsol-v9`);
  const d = readDeployments(networkName) as Record<string, { address?: `0x${string}` }>;
  const usersAddr = d["ERC20Users"]?.address;
  if (!usersAddr) throw new Error("ERC20Users missing");
  const mint = base58ToBytes32(WSOL_MINT) as `0x${string}`;
  const w = await viem.deployContract("SPL_ERC20", [mint, CPI, "Rome WSOL (v9 ensureRecipientAta)", "WSOLv9", usersAddr]);
  console.log("=== DEPLOYED WSOL v9 ===");
  console.log(`Address: ${w.address}`);
}
main().catch(e => { console.error(e); process.exit(1); });
