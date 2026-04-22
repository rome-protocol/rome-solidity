import hardhat from "hardhat";
async function main() {
  const { viem } = await hardhat.network.connect();
  const [a] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const deployer = a.account!.address;
  const NEW_RETH = "0xf36ad574687dfc25d0ca63f8fd27271a85ca9550";
  const users = await viem.getContractAt("ERC20Users", "0x803f6923bcc776db1d0aa6fcdbd8ceddf35ad6f3");
  const rETH = await viem.getContractAt("SPL_ERC20", NEW_RETH);

  console.log("Deployer:", deployer);
  console.log("New rETH :", NEW_RETH);
  console.log("mint_id  :", await rETH.read.mint_id());

  try {
    console.log("ensure_user ...");
    const tx = await users.write.ensure_user([deployer]);
    console.log("  tx:", tx);
    await pc.waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
  } catch (e: any) {
    console.log("  (likely already exists):", (e.shortMessage || e.message).slice(0, 120));
  }

  try {
    console.log("ensure_token_account (rETH)...");
    const tx = await rETH.write.ensure_token_account([deployer]);
    console.log("  tx:", tx);
    await pc.waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
  } catch (e: any) {
    console.log("  err:", (e.shortMessage || e.message).slice(0, 200));
  }

  try {
    const bal = await rETH.read.balanceOf([deployer]);
    console.log("balanceOf:", bal.toString());
  } catch (e: any) {
    console.log("balanceOf err:", (e.shortMessage || e.message).slice(0, 200));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
