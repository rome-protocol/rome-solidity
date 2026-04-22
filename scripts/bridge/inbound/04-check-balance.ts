// Step 4 of CCTP inbound demo: read rUSDC balance on marcus to confirm the
// Solana-side mint propagated. Run before step 1 and again after step 3 to
// see the delta.
import hardhat from "hardhat";
async function main() {
  const { viem } = await hardhat.network.connect();
  const [admin] = await viem.getWalletClients();
  const deployer = admin.account!.address;
  const rUSDC = await viem.getContractAt("SPL_ERC20", "0x6ed2944bba4cb5b1cb295541f315c648658dd67c");
  const bal = await rUSDC.read.balanceOf([deployer]);
  console.log("rUSDC balance:", bal.toString(), "base units =", Number(bal) / 1e6, "USDC");
}
main().catch(e => { console.error(e); process.exit(1); });
