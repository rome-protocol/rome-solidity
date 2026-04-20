// scripts/bridge/constants.ts
export const SOLANA_PROGRAM_IDS = {
  WORMHOLE_CORE: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
  WORMHOLE_TOKEN_BRIDGE: "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb",
  CCTP_MESSAGE_TRANSMITTER: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
  CCTP_TOKEN_MESSENGER: "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
  CCTP_TOKEN_MINTER: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
  SPL_TOKEN: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  ASSOCIATED_TOKEN: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  SYSTEM_PROGRAM: "11111111111111111111111111111111",
} as const;

export const SPL_MINTS = {
  USDC_NATIVE: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  WETH_WORMHOLE: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
} as const;

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
