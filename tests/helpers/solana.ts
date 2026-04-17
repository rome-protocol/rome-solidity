/**
 * solana.ts — lazy Solana connection helper for integration tests.
 *
 * Returns env config and a Connection if:
 *   - RUN_EVENT_PDA_INTEGRATION=1 is set, AND
 *   - SOLANA_RPC_URL, ROME_EVM_PROGRAM_ID, ROME_CHAIN_ID are all set.
 *
 * Returns null otherwise — callers should skip the PDA check.
 *
 * @solana/web3.js is NOT listed in package.json. getSolanaConnection() uses a
 * dynamic import so that the module loads (and tests compile) without the package
 * installed. Tests that call getSolanaConnection() are only reached when
 * RUN_EVENT_PDA_INTEGRATION=1, at which point the Solana package must be available.
 */

export interface SolanaEnv {
  rpcUrl: string;
  programId: string;
  chainId: bigint;
}

/**
 * Returns the Solana env config if all required env vars are set and
 * RUN_EVENT_PDA_INTEGRATION=1 is active; null otherwise.
 */
export async function getSolanaEnv(): Promise<SolanaEnv | null> {
  if (process.env["RUN_EVENT_PDA_INTEGRATION"] !== "1") return null;

  const rpcUrl    = process.env["SOLANA_RPC_URL"];
  const programId = process.env["ROME_EVM_PROGRAM_ID"];
  const chainIdStr = process.env["ROME_CHAIN_ID"];

  if (!rpcUrl || !programId || !chainIdStr) {
    console.warn(
      "[T14] integration env incomplete — skipping ring-PDA verification.",
      { rpcUrl: !!rpcUrl, programId: !!programId, chainId: !!chainIdStr },
    );
    return null;
  }

  return { rpcUrl, programId, chainId: BigInt(chainIdStr) };
}

/**
 * Returns a Solana Connection for the given env config.
 *
 * Dynamically imports @solana/web3.js — only call this inside integration-gated
 * code paths where the package is guaranteed to be installed.
 *
 * @returns any — typed as any to avoid needing @solana/web3.js types at compile time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getSolanaConnection(env: SolanaEnv): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Connection } = await import("@solana/web3.js") as any;
  return new Connection(env.rpcUrl, "confirmed");
}
