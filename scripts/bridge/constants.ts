// scripts/bridge/constants.ts
// Canonical Solana program IDs and mint addresses for Rome Bridge Phase 1.
// Keep this file in sync with on-chain addresses at deploy time.
export const SOLANA_PROGRAM_IDS = {
  // Wormhole Core (attestation bridge — VAA producer)
  WORMHOLE_CORE: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
  // Wormhole Token Bridge (lock/mint token transfers across chains)
  WORMHOLE_TOKEN_BRIDGE: "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb",
  // CCTP Message Transmitter (burns/mints USDC cross-chain messages)
  CCTP_MESSAGE_TRANSMITTER: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
  // CCTP Token Messenger (initiates depositForBurn and receiveMessage flows)
  CCTP_TOKEN_MESSENGER: "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
  // CCTP Token Minter (mints/burns USDC under Token Messenger authority)
  CCTP_TOKEN_MINTER: "11111111111111111111111111111111", // FIXME: replace with real CCTP Token Minter program ID — Phase 1.5 derivation script overrides.
  // SPL Token program (standard Solana fungible token operations)
  SPL_TOKEN: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  // Associated Token Account program (creates deterministic ATAs)
  ASSOCIATED_TOKEN: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  // Solana System Program (account creation, SOL transfers)
  SYSTEM_PROGRAM: "11111111111111111111111111111111",
} as const;

// Canonical Phase 1 mainnet mints (Solana mainnet-beta) — used on mainnet deploys.
export const SPL_MINTS_MAINNET = {
  USDC_NATIVE: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  WETH_WORMHOLE: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
} as const;

// Devnet mints — USDC is Circle's devnet USDC; wETH is a test mint owned by
// the Rome devnet registration authority (created manually until Wormhole
// publishes a canonical devnet wETH mint we can reuse).
export const SPL_MINTS_DEVNET = {
  USDC_NATIVE: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  WETH_WORMHOLE: "2kCwKGBvGfoY7EKHPmCwsZXamxzDMbqn1uDZMqXfve6i",
} as const;

// Default export — points at devnet for now since active deploys target
// marcus/monti_spl. Switch to SPL_MINTS_MAINNET for mainnet.
export const SPL_MINTS = SPL_MINTS_DEVNET;

export const CCTP_DOMAINS = { ETHEREUM: 0, SOLANA: 5 } as const;
export const WORMHOLE_CHAIN_IDS = { ETHEREUM: 2, SOLANA: 1 } as const;

// Placeholders — verify against live IDL at deploy time.
export const CCTP_DISCRIMINATORS = {
  DEPOSIT_FOR_BURN: "0x6d8ab0e1d8a34c4e",
  RECEIVE_MESSAGE:  "0x3b2b05e7a3f27f9a",
} as const;

// Wormhole Token Bridge uses native Solana (not Anchor) — single-byte tag.
export const WORMHOLE_DISCRIMINATORS = {
  TRANSFER_TOKENS: "0x04",
  COMPLETE_TRANSFER: "0x02",
} as const;

export type SolanaProgramKey = keyof typeof SOLANA_PROGRAM_IDS;
