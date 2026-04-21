import hardhat from "hardhat";
import { keccak256, toUtf8Bytes } from "ethers";

async function main() {
  const { viem } = await hardhat.network.connect();
  const [admin] = await viem.getWalletClients();
  const deployer = admin.account!.address;

  const d = JSON.parse(
    (await import("node:fs")).readFileSync("deployments/marcus.json", "utf8"),
  );
  const paymaster = d.RomeBridgePaymaster.address;
  const rEthAddr  = d.SPL_ERC20_WETH.address;
  const withdraw  = d.RomeBridgeWithdraw.address;
  const expectedMintBase58 = d.SPL_ERC20_WETH.mintId;
  console.log("Deployer:", deployer);
  console.log("Paymaster:", paymaster);
  console.log("rETH:", rEthAddr);
  console.log("Withdraw:", withdraw);
  console.log("Expected canonical mint:", expectedMintBase58);

  // SPL_ERC20 exposes the mint as `mint_id` (bytes32 public immutable)
  const rEth = await viem.getContractAt("SPL_ERC20", rEthAddr);
  const mintBytes32 = await rEth.read.mint_id();
  const { default: bs58 } = await import("bs58");
  const mintBase58 = bs58.encode(Buffer.from(mintBytes32.slice(2), "hex"));
  console.log("rETH.mint_id():", mintBase58);
  if (mintBase58 !== expectedMintBase58) {
    throw new Error(`rETH.mint_id() mismatch: got ${mintBase58} expected ${expectedMintBase58}`);
  }
  console.log("  ✓ rETH wired to canonical mint");

  // Verify paymaster allowlist entries — mapping is named `allowlist` (not `allowlisted`)
  const paymasterC = await viem.getContractAt("RomeBridgePaymaster", paymaster);
  const burnEthSel = ("0x" + keccak256(toUtf8Bytes("burnETH(uint256,address)")).slice(2, 10)) as `0x${string}`;
  const allowed = await paymasterC.read.allowlist([withdraw, burnEthSel]);
  if (!allowed) throw new Error("Paymaster allowlist missing burnETH on new withdraw");
  console.log("  ✓ paymaster allowlist: withdraw+burnETH enabled");

  // Touch ensure_token_account to confirm wrapper can read SPL state (idempotent)
  try {
    await rEth.write.ensure_token_account([deployer]);
    console.log("  ✓ ensure_token_account on rETH succeeded (ATA exists or created)");
  } catch (e: any) {
    if (/already exists/i.test(e.shortMessage || e.message || "")) {
      console.log("  ✓ ensure_token_account: ATA already exists");
    } else {
      throw e;
    }
  }

  console.log("\n✓ Smoke test passed — redeploy is healthy.");
}
main().catch((e) => { console.error(e); process.exit(1); });
