import hardhat from "hardhat";

// Step 1: deployer calls ERC20Users.ensure_user(deployer) -> creates payer PDA
// Step 2: deployer calls SPL_ERC20.ensure_token_account(deployer) -> creates ATA, caches _accounts[deployer]
// After this, balanceOf(deployer) will work and return the SPL balance of the ATA.
// Funding USDC into that ATA is done via spl-token CLI separately (outside this script).

async function main() {
  const conn = await hardhat.network.connect();
  const { viem, networkName } = conn;
  const [admin] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const deployer = admin.account!.address;

  console.log(`[${networkName}] deployer:`, deployer);

  // Minimal ABIs — only the functions we need.
  const ERC20_USERS_ABI = [
    {
      type: "function", name: "ensure_user", stateMutability: "nonpayable",
      inputs: [{ name: "user", type: "address" }],
      outputs: [{ components: [
        { name: "payer", type: "bytes32" },
        { name: "owner", type: "bytes32" },
        { name: "seed", type: "bytes32" },
      ], name: "", type: "tuple" }],
    },
    {
      type: "function", name: "get_user", stateMutability: "view",
      inputs: [{ name: "user", type: "address" }],
      outputs: [{ components: [
        { name: "payer", type: "bytes32" },
        { name: "owner", type: "bytes32" },
        { name: "seed", type: "bytes32" },
      ], name: "", type: "tuple" }],
    },
  ] as const;

  const SPL_ERC20_ABI = [
    {
      type: "function", name: "ensure_token_account", stateMutability: "nonpayable",
      inputs: [{ name: "user", type: "address" }],
      outputs: [{ name: "", type: "bytes32" }],
    },
    {
      type: "function", name: "get_token_account", stateMutability: "view",
      inputs: [{ name: "user", type: "address" }],
      outputs: [{ name: "", type: "bytes32" }],
    },
    {
      type: "function", name: "balanceOf", stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ] as const;

  const ERC20_USERS_ADDR = "0xcc8dcfb6b0489e0569599af9a32862fc8175a26b" as const;
  const RUSDC_ADDR = "0x2075ef4a314130b0a9433854ae6096dcfc7bbf55" as const;

  const users = await viem.getContractAt("ERC20Users", ERC20_USERS_ADDR);
  const rUSDC = await viem.getContractAt("SPL_ERC20", RUSDC_ADDR);

  console.log("\n[1/3] Ensuring deployer's ERC20Users.User record...");
  try {
    const hash = await users.write.ensure_user([deployer]);
    const rcpt = await pc.waitForTransactionReceipt({ hash });
    console.log("      ensure_user tx:", hash, "status:", rcpt.status);
  } catch (e: any) {
    console.log("      ensure_user failed (maybe already exists):", e.shortMessage || e.message);
  }

  console.log("\n[2/3] Ensuring deployer's rUSDC ATA (SPL_ERC20.ensure_token_account)...");
  try {
    const hash = await rUSDC.write.ensure_token_account([deployer]);
    const rcpt = await pc.waitForTransactionReceipt({ hash });
    console.log("      ensure_token_account tx:", hash, "status:", rcpt.status);
  } catch (e: any) {
    console.log("      ensure_token_account failed:", e.shortMessage || e.message);
  }

  console.log("\n[3/3] Reading current rUSDC state for deployer...");
  try {
    const ata = await rUSDC.read.get_token_account([deployer]);
    console.log("      ATA (bytes32):", ata);
    // Convert to base58 using imported bs58
    const { default: bs58 } = await import("bs58");
    const ataBuf = Buffer.from(ata.slice(2), "hex");
    console.log("      ATA (base58):", bs58.encode(ataBuf));
    const bal = await rUSDC.read.balanceOf([deployer]);
    console.log("      balanceOf(deployer):", bal.toString(), "raw");
  } catch (e: any) {
    console.log("      read failed:", e.shortMessage || e.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
