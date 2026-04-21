import { Connection } from "@solana/web3.js";
import { deriveCanonicalWrappedMint } from "./lib/canonical-mint.js";
import { verifyMintOnChain } from "./lib/verify-mint-on-chain.js";

const WORMHOLE_TOKEN_BRIDGE_DEVNET = "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe";
const SEPOLIA_WETH_TOKEN_CHAIN = 10002;
const SEPOLIA_WETH_TOKEN_ADDR  = "eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c";

const ENDPOINTS = [
  { label: "Rome RPC (marcus)", url: "https://node1.devnet-eu-sol-api.devnet.romeprotocol.xyz" },
  { label: "Public Solana devnet", url: "https://api.devnet.solana.com" },
];

async function main() {
  const mint = deriveCanonicalWrappedMint({
    tokenChain: SEPOLIA_WETH_TOKEN_CHAIN,
    tokenAddressHex: SEPOLIA_WETH_TOKEN_ADDR,
    tokenBridgeProgramId: WORMHOLE_TOKEN_BRIDGE_DEVNET,
  });
  console.log("Derived canonical Wormhole-wrapped Sepolia WETH mint:");
  console.log("  pubkey:", mint.toBase58());

  for (const ep of ENDPOINTS) {
    process.stdout.write(`  ${ep.label} (${ep.url}): `);
    try {
      const conn = new Connection(ep.url, "confirmed");
      await verifyMintOnChain(conn, mint.toBase58());
      console.log("exists, owned by SPL Token ✓");
    } catch (e: unknown) {
      console.log(`FAILED — ${(e as Error).message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
