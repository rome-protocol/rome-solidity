import { PublicKey } from "@solana/web3.js";

const SPL_TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/**
 * The associated token account of `owner` for `mint`. Same derivation as
 * @solana/spl-token's getAssociatedTokenAddressSync with allowOwnerOffCurve —
 * the bridge PDA is off-curve, so the owner-on-curve check must not apply.
 */
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  );
  return ata;
}

export type BridgedMint = { mint: string; symbol: string };

function isPubkey(s: string): boolean {
  try {
    return new PublicKey(s).toBytes().length === 32;
  } catch {
    return false;
  }
}

/**
 * Which SPL mints the bridge must own an ATA for.
 *
 * `explicit` (BRIDGE_ATA_MINTS, comma-separated base58) wins verbatim when set.
 * Otherwise every `SPL_ERC20_*` wrapper in deployments/<network>.json that
 * carries a base58 `mintId` — the bridged assets the bootstrap wrote. Cached
 * test wrappers carry `mint` as bytes32 hex and are not bridged; they are
 * skipped. An empty result is an error: the owner call spends operator rent
 * per mint, and a run that does nothing must not read as done.
 */
export function bridgedMintsFrom(
  deployments: Record<string, unknown>,
  explicit: string | undefined,
): BridgedMint[] {
  const wrappers: BridgedMint[] = [];
  for (const [key, value] of Object.entries(deployments)) {
    if (!key.startsWith("SPL_ERC20_") || typeof value !== "object" || value === null) continue;
    const { mintId, symbol } = value as { mintId?: unknown; symbol?: unknown };
    if (typeof mintId !== "string" || !isPubkey(mintId)) continue;
    wrappers.push({ mint: mintId, symbol: typeof symbol === "string" ? symbol : key });
  }

  const wanted = (explicit ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (wanted.length === 0) {
    if (wrappers.length === 0) throw new Error("no bridged mints: deployments carry no SPL_ERC20_* wrapper with a mintId and BRIDGE_ATA_MINTS is unset");
    return wrappers;
  }
  return wanted.map((mint) => {
    if (!isPubkey(mint)) throw new Error(`BRIDGE_ATA_MINTS entry "${mint}" is not a Solana pubkey`);
    const known = wrappers.find((w) => w.mint === mint);
    return { mint, symbol: known?.symbol ?? mint.slice(0, 8) + "…" };
  });
}
