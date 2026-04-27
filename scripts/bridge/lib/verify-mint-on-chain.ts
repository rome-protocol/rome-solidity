import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * Fetches the account at `mintBase58` from the given connection and verifies
 * it is owned by the SPL Token program. Throws with a descriptive error
 * otherwise — redeploy scripts should abort when this throws.
 */
export async function verifyMintOnChain(
  connection: Connection,
  mintBase58: string,
): Promise<true> {
  const info = await connection.getAccountInfo(new PublicKey(mintBase58));
  if (!info) {
    throw new Error(`Mint ${mintBase58} not found on-chain`);
  }
  if (info.owner.toBase58() !== SPL_TOKEN_PROGRAM) {
    throw new Error(
      `Mint ${mintBase58} owner mismatch: expected ${SPL_TOKEN_PROGRAM}, got ${info.owner.toBase58()}`,
    );
  }
  return true;
}
