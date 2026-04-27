// Reads the deployer's Rome PDA USDC ATA on Solana via the SPL_ERC20 rUSDC
// wrapper on marcus. This ATA is the `mintRecipient` for CCTP depositForBurn
// calls on Ethereum testnet that target this Rome user.
import hardhat from "hardhat";
async function main() {
  const { viem } = await hardhat.network.connect();
  const [admin] = await viem.getWalletClients();
  const deployer = admin.account!.address;
  const rUSDC = await viem.getContractAt("SPL_ERC20", "0x6ed2944bba4cb5b1cb295541f315c648658dd67c");
  const ata = await rUSDC.read.get_token_account([deployer]);
  const { default: bs58 } = await import("bs58");
  const b = Buffer.from(ata.slice(2), "hex");
  console.log("Deployer EVM address:  ", deployer);
  console.log("rUSDC ATA (bytes32):   ", ata);
  console.log("rUSDC ATA (base58):    ", bs58.encode(b));
}
main().catch(e => { console.error(e); process.exit(1); });
