import { describe, it, expect } from "vitest";
import { deriveCanonicalWrappedMint } from "./canonical-mint.js";

describe("deriveCanonicalWrappedMint", () => {
  it("derives Wormhole-wrapped Sepolia WETH on Solana devnet", () => {
    // Sourced from PR#38 src/features/bridge/wormhole/constants.ts:
    //   tokenChain: 10002, tokenAddress: "000000000000000000000000eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c"
    //   Wormhole Token Bridge on Solana devnet: "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe"
    const mint = deriveCanonicalWrappedMint({
      tokenChain: 10002,
      tokenAddressHex: "eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c",
      tokenBridgeProgramId: "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
    });

    // The derived pubkey is deterministic; this is what
    // PublicKey.findProgramAddressSync returns on any correct implementation.
    expect(mint.toBase58()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    // Exact value — regenerate once and pin. Computed via:
    //   PublicKey.findProgramAddressSync(
    //     [Buffer.from("wrapped"), u16be(10002), pad32("eef12a83...")],
    //     new PublicKey("DZnkkTmC..."))
    expect(mint.toBase58()).toBe("6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs");
  });

  it("left-pads 40-char hex token address to 32 bytes", () => {
    // Same derivation but asserting the padding behaviour explicitly by
    // passing with/without 0x prefix — both should yield same result.
    const a = deriveCanonicalWrappedMint({
      tokenChain: 10002,
      tokenAddressHex: "0xeef12a83ee5b7161d3873317c8e0e7b76e0b5d9c",
      tokenBridgeProgramId: "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
    });
    const b = deriveCanonicalWrappedMint({
      tokenChain: 10002,
      tokenAddressHex: "eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c",
      tokenBridgeProgramId: "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
    });
    expect(a.equals(b)).toBe(true);
  });

  it("throws on invalid token address length", () => {
    expect(() =>
      deriveCanonicalWrappedMint({
        tokenChain: 10002,
        tokenAddressHex: "deadbeef",
        tokenBridgeProgramId: "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
      }),
    ).toThrow(/token address.*40 hex/i);
  });
});
