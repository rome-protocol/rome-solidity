import { PublicKey, Connection } from "@solana/web3.js";

const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const USDC_MINT = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const RECIPIENT = new PublicKey("AVqgWKZ8U6P2nKkw2PQVw3z6unJ2W9JKmPYoSXjpkx2L");

async function main() {
  const [recipientAta] = PublicKey.findProgramAddressSync(
    [RECIPIENT.toBuffer(), SPL_TOKEN.toBuffer(), USDC_MINT.toBuffer()],
    ATA_PROGRAM,
  );
  console.log(`Recipient: ${RECIPIENT.toBase58()}`);
  console.log(`USDC ATA:  ${recipientAta.toBase58()}`);

  const conn = new Connection((process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com"), "confirmed");
  const info = await conn.getAccountInfo(recipientAta);
  if (!info) { console.log("ATA NOT INITIALIZED"); return; }
  const owner = new PublicKey(info.data.subarray(32, 64));
  const amount = info.data.readBigUInt64LE(64);
  console.log(`\nOn-chain ATA state:`);
  console.log(`  owner: ${owner.toBase58()}  ${owner.equals(RECIPIENT) ? "✓ matches recipient" : "✗"}`);
  console.log(`  amount: ${amount} (= ${Number(amount) / 1e6} USDC)`);
  console.log(`  data len: ${info.data.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
