/**
 * Which Wormhole destination a Rome network's outbound ETH/SPL egress targets.
 *
 * It is a function of the Solana cluster the chain settles on, nothing else:
 * every Rome chain on Solana DEVNET has Sepolia as its source EVM and bridges
 * back to Wormhole chain 10002; a chain on mainnet-beta bridges to Ethereum (2).
 * Keeping ONE set here (the same set deploy.ts uses to pick devnet vs mainnet
 * CCTP/Wormhole program ids) removes the second hand-maintained list that sent
 * Martius and Nerva to chain 2. Add a new devnet-substrate chain here once.
 */
export const SOLANA_DEVNET_NETWORKS: ReadonlySet<string> = new Set([
  "local", "subura", "esquiline", "hadrian", "martius", "nerva",
]);

export const WORMHOLE_CHAIN_ETHEREUM = 2;
export const WORMHOLE_CHAIN_SEPOLIA = 10002;

export function isSolanaDevnetNetwork(networkName: string): boolean {
  return SOLANA_DEVNET_NETWORKS.has(networkName);
}

export function wormholeTargetChainFor(networkName: string): number {
  return isSolanaDevnetNetwork(networkName) ? WORMHOLE_CHAIN_SEPOLIA : WORMHOLE_CHAIN_ETHEREUM;
}
