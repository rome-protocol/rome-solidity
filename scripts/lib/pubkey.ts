import bs58 from "bs58";

/// Converts a Solana base58 pubkey into the hex-encoded bytes32 format Solidity expects.
export function base58ToBytes32(base58: string): `0x${string}` {
  const bytes = bs58.decode(base58);
  if (bytes.length !== 32) {
    throw new Error(`Expected 32 bytes, got ${bytes.length} for "${base58}"`);
  }
  return ("0x" + Buffer.from(bytes).toString("hex")) as `0x${string}`;
}
