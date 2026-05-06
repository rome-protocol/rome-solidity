// Audit: derive the wormhole-wrapped Sepolia ETH mint under BOTH mainnet and
// devnet Token Bridge program IDs. Compare with what the bridge contract has
// stored. Also verify the on-chain wethMint's data ownership.

import { PublicKey, Connection } from "@solana/web3.js";

const WH_TB_MAINNET = new PublicKey("wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb");
const WH_TB_DEVNET  = new PublicKey("DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe");
const STORED_WETH_MINT = new PublicKey("6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs");

// Sepolia chain id in Wormhole = 10002, mainnet ETH chain id = 2
function deriveWrappedMint(tokenBridge: PublicKey, chainId: number, tokenAddress20: string): PublicKey {
  const chainBE = Buffer.alloc(2);
  chainBE.writeUInt16BE(chainId, 0);
  const tokenBuf = Buffer.alloc(32);
  Buffer.from(tokenAddress20.replace(/^0x/, ""), "hex").copy(tokenBuf, 12);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("wrapped"), chainBE, tokenBuf],
    tokenBridge,
  );
  return pda;
}

async function main() {
  // Sepolia ETH placeholder (used for the wrapped mint derivation per
  // Wormhole convention — the canonical Sepolia ETH address tracker).
  // This is a publicly-documented address, not a secret. ggshield: ignore
  const SEPOLIA_ETH_TOKEN_ADDR = "eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c"; // ggshield-ignore
  // Mainnet Wormhole-wrapped ETH on Solana mainnet: 7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs
  const MAINNET_ETH_TOKEN_ADDR = "0000000000000000000000000000000000000000";  // ETH "address" is null-y in Wormhole CG

  console.log(`STORED wethMint:         ${STORED_WETH_MINT.toBase58()}\n`);

  // Derive against both bridges + relevant chain ids
  console.log("=== DEVNET WH_TB (DZnkkTm…) derivations ===");
  const devnetSepolia = deriveWrappedMint(WH_TB_DEVNET, 10002, SEPOLIA_ETH_TOKEN_ADDR);
  console.log(`  chain=10002 (Sepolia), addr=eef12a83…d9c → ${devnetSepolia.toBase58()}  ${devnetSepolia.equals(STORED_WETH_MINT) ? "✓ MATCHES STORED" : ""}`);
  // Try chain=2 (mainnet ETH-style) under devnet
  const devnetMainnet = deriveWrappedMint(WH_TB_DEVNET, 2, SEPOLIA_ETH_TOKEN_ADDR);
  console.log(`  chain=2 (mainnet ETH), addr=eef12a83…d9c → ${devnetMainnet.toBase58()}  ${devnetMainnet.equals(STORED_WETH_MINT) ? "✓ MATCHES STORED" : ""}`);

  console.log("\n=== MAINNET WH_TB (wormDTUJ6…) derivations ===");
  const mainnetSepolia = deriveWrappedMint(WH_TB_MAINNET, 10002, SEPOLIA_ETH_TOKEN_ADDR);
  console.log(`  chain=10002 (Sepolia), addr=eef12a83…d9c → ${mainnetSepolia.toBase58()}  ${mainnetSepolia.equals(STORED_WETH_MINT) ? "✓ MATCHES STORED" : ""}`);
  const mainnetMainnet = deriveWrappedMint(WH_TB_MAINNET, 2, SEPOLIA_ETH_TOKEN_ADDR);
  console.log(`  chain=2 (mainnet ETH), addr=eef12a83…d9c → ${mainnetMainnet.toBase58()}  ${mainnetMainnet.equals(STORED_WETH_MINT) ? "✓ MATCHES STORED" : ""}`);

  console.log("\n=== On-chain ownership of stored wethMint ===");
  const conn = new Connection("https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz", "confirmed");
  const info = await conn.getAccountInfo(STORED_WETH_MINT);
  console.log(`  exists: ${!!info}`);
  console.log(`  owner: ${info?.owner.toBase58() ?? "n/a"} (should be SPL Token program: TokenkegQ…)`);
  console.log(`  data len: ${info?.data?.length ?? 0} (mint accounts are 82 bytes)`);
  // Mint account layout: mint_authority option (4+32) + supply (8) + decimals (1) + ...
  if (info && info.data.length >= 45) {
    const mintAuthOption = info.data.readUInt32LE(0);
    const mintAuth = mintAuthOption === 1 ? new PublicKey(info.data.subarray(4, 36)) : null;
    const decimals = info.data.readUInt8(44);
    console.log(`  mint_authority: ${mintAuth?.toBase58() ?? "(none)"}`);
    console.log(`  decimals: ${decimals}`);
  }

  // Also check the wrapped_meta PDA for this mint under devnet vs mainnet
  console.log("\n=== wrapped_meta PDA under each WH_TB ===");
  const [wmDevnet] = PublicKey.findProgramAddressSync(
    [Buffer.from("meta"), STORED_WETH_MINT.toBuffer()],
    WH_TB_DEVNET,
  );
  const [wmMainnet] = PublicKey.findProgramAddressSync(
    [Buffer.from("meta"), STORED_WETH_MINT.toBuffer()],
    WH_TB_MAINNET,
  );
  console.log(`  wrapped_meta (devnet WH_TB): ${wmDevnet.toBase58()}`);
  console.log(`  wrapped_meta (mainnet WH_TB): ${wmMainnet.toBase58()}`);
  for (const [name, pk] of [["devnet wrapped_meta", wmDevnet], ["mainnet wrapped_meta", wmMainnet]] as const) {
    const wmInfo = await conn.getAccountInfo(pk);
    console.log(`  ${name} on-chain: exists=${!!wmInfo}, owner=${wmInfo?.owner.toBase58() ?? "n/a"}, data len=${wmInfo?.data.length ?? 0}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
