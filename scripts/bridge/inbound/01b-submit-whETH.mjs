// Inbound Wormhole: wrapAndTransferETH on Sepolia.
// Recipient is the Rome user's PDA wETH ATA (canonical Wormhole wrapped mint).

import { Wallet, JsonRpcProvider, Contract, parseEther } from "ethers";
import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";

const SPL_TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
function getAssociatedTokenAddressSync(mint, owner) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  );
  return ata;
}

const SEPOLIA_TOKEN_BRIDGE = "0xDB5492265f6038831E89f495670FF909aDe94bd9";
const WH_CHAIN_SOLANA = 1;
const CANONICAL_WETH_MINT = "6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs";
const ROLLUP_PROGRAM = "DP1dshBzmXXVsRxH5kCKMemrDuptg1JvJ1j5AsFV4Hm3";
const MARCUS_USER_EVM = "0x3403e0De09Bc76Ca7d74762F264e4F6B649A0562";

const RPC = "https://sepolia.drpc.org";
const ABI = [
  "function wrapAndTransferETH(uint16 recipientChain, bytes32 recipient, uint256 arbiterFee, uint32 nonce) external payable returns (uint64)",
];

const main = async () => {
  const key = fs.readFileSync(".secrets/sepolia-key.txt", "utf8").trim();
  const prov = new JsonRpcProvider(RPC);
  const signer = new Wallet(key, prov);
  console.log("Signer:", signer.address);

  // Derive user PDA + ATA
  const evmBytes = Buffer.from(MARCUS_USER_EVM.replace(/^0x/, "").toLowerCase(), "hex");
  const [userPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("EXTERNAL_AUTHORITY"), evmBytes],
    new PublicKey(ROLLUP_PROGRAM),
  );
  const recipientAta = getAssociatedTokenAddressSync(
    new PublicKey(CANONICAL_WETH_MINT),
    userPda,
  );
  const recipientBytes32 = "0x" + Buffer.from(recipientAta.toBytes()).toString("hex");
  console.log("User PDA:        ", userPda.toBase58());
  console.log("Recipient ATA:   ", recipientAta.toBase58());

  const amountStr = "0.001";
  const valueWei = parseEther(amountStr);
  const nonce = Math.floor(Math.random() * 0xffffffff);

  const c = new Contract(SEPOLIA_TOKEN_BRIDGE, ABI, signer);
  console.log(`\nSubmitting wrapAndTransferETH(${amountStr} ETH → Solana, recipient=${recipientBytes32.slice(0,10)}…)`);
  const tx = await c.wrapAndTransferETH(WH_CHAIN_SOLANA, recipientBytes32, 0n, nonce, { value: valueWei });
  console.log("  tx:", tx.hash);
  const rcpt = await tx.wait();
  console.log("  mined block:", rcpt.blockNumber, "status:", rcpt.status);

  const out = {
    txHash: tx.hash,
    block: rcpt.blockNumber,
    sender: signer.address,
    amountRaw: valueWei.toString(),
    recipientAta: recipientAta.toBase58(),
    userEvm: MARCUS_USER_EVM,
  };
  fs.writeFileSync(".secrets/last-wh-inbound.json", JSON.stringify(out, null, 2));
  console.log("\n✓ Saved to .secrets/last-wh-inbound.json");
};
main().catch(e => { console.error(e); process.exit(1); });
