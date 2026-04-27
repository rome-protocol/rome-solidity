import { PublicKey } from "@solana/web3.js";

export interface CanonicalMintParams {
  /** Wormhole chain ID of the source token */
  tokenChain: number;
  /** 40-char hex (with or without 0x prefix) of the source-chain token address */
  tokenAddressHex: string;
  /** Solana pubkey (base58) of the Wormhole Token Bridge program */
  tokenBridgeProgramId: string;
}

/**
 * Derive Wormhole's canonical wrapped-mint PDA on the target chain
 * (Solana). Seeds: `[b"wrapped", u16_be(chain), pad32(addr)]` under the
 * Token Bridge program.
 */
export function deriveCanonicalWrappedMint(p: CanonicalMintParams): PublicKey {
  const hex = p.tokenAddressHex.replace(/^0x/, "").toLowerCase();
  if (hex.length !== 40) {
    throw new Error(
      `token address must be 40 hex chars (20 bytes), got ${hex.length}`,
    );
  }
  const tokenAddr = Buffer.concat([
    Buffer.alloc(12), // left-pad to 32 bytes
    Buffer.from(hex, "hex"),
  ]);
  const chainBuf = Buffer.alloc(2);
  chainBuf.writeUInt16BE(p.tokenChain, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("wrapped"), chainBuf, tokenAddr],
    new PublicKey(p.tokenBridgeProgramId),
  );
  return pda;
}
