// scripts/bridge/constants.ts
// Canonical Solana program IDs and mint addresses for Rome Bridge Phase 1.
// Keep this file in sync with on-chain addresses at deploy time.
export const SOLANA_PROGRAM_IDS = {
  // Wormhole Core (attestation bridge — VAA producer) — MAINNET
  WORMHOLE_CORE: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
  // Wormhole Token Bridge (lock/mint token transfers across chains) — MAINNET
  WORMHOLE_TOKEN_BRIDGE: "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb",
  // CCTP Message Transmitter (burns/mints USDC cross-chain messages)
  CCTP_MESSAGE_TRANSMITTER: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
  /** CCTP **v2** Token Messenger Minter — deterministic, SAME id on devnet
   *  and mainnet (unlike most Circle v1 ids). v6 bridge burns route here. */
  CCTP_V2_TOKEN_MESSENGER: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
  /** CCTP **v2** Message Transmitter — deterministic, same both clusters. */
  CCTP_V2_MESSAGE_TRANSMITTER: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",
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

// Solana devnet/testnet overrides. Wormhole runs separate program deployments
// on testnet; the pubkeys here are the canonical Wormhole testnet IDs used by
// wormhole-foundation/wormhole repo.
export const SOLANA_PROGRAM_IDS_DEVNET = {
  ...SOLANA_PROGRAM_IDS,
  WORMHOLE_CORE:         "3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5",
  WORMHOLE_TOKEN_BRIDGE: "DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe",
} as const;

// Canonical Phase 1 mainnet mints (Solana mainnet-beta) — used on mainnet deploys.
// WSOL_NATIVE is the canonical wrapped-SOL mint — same pubkey on devnet AND
// mainnet because it's effectively a one-off "wrap SOL → SPL" mint owned by
// the SPL Token program itself. Included alongside USDC/WETH so
// SimpleActivator's `WSOL_WRAPPER` + Romeswap's wSOL pool seeding have a
// wrapper to point at after bring-up.
export const SPL_MINTS_MAINNET = {
  USDC_NATIVE: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  WETH_WORMHOLE: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  WSOL_NATIVE: "So11111111111111111111111111111111111111112",
} as const;

// Devnet mints — USDC is Circle's devnet USDC; wETH is the canonical
// Wormhole-wrapped ETH mint for Sepolia (tokenChain=10002, tokenAddress=
// eef12a83ee5b7161d3873317c8e0e7b76e0b5d9c), derived via Wormhole's
// [b"wrapped", chain(u16 BE), token_address(32)] seed layout. This matches
// the mint the on-chain rETH wrapper (SPL_ERC20_WETH) binds to — keeping it
// in sync so deriveWormholeAccounts produces the correct wrappedMeta PDA.
export const SPL_MINTS_DEVNET = {
  USDC_NATIVE: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  WETH_WORMHOLE: "6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs",
  WSOL_NATIVE: "So11111111111111111111111111111111111111112",
} as const;

// Compound-collateral test mints (Solana devnet only — Rome-minted test
// assets, no mainnet counterpart). These are the underlying mints of the
// 6 exotic collaterals on Hadrian's canonical 9-asset Comet; wrapping the
// SAME mints on any devnet-substrate chain keeps the asset set identical
// across chains. Extracted from the live Hadrian wrappers' mint_id()
// (2026-07-01); mint authority 3E7gp1p8CfZ8kXMUagqKQWYZijQm7hxkrE67eQZPLdfv.
export const COMPOUND_COLLATERAL_MINTS_DEVNET = {
  BTC_TEST: "2gsErzRCTA7T6hGnYo44EnpP7hP79CHQerDhtmggkZZF",
  JITOSOL_TEST: "8Eou1ZHTULFvoaELa9Dnw29puHdckcsj7buQKNqfaZHH",
  MSOL_TEST: "jc65vCfDLKm9sW7auJMkNJZuE6jnsqfW9bHHvYp9oYE",
  JUP_TEST: "Aa58JCN8MCDPSAPe6qZiL1ZWtqxVDRdSjH6EGjku5vFe",
  JTO_TEST: "F2Vr2fWpi4quVQSc8SGk2XyVaxmDMLRTvoeDGEMbvUZq",
  BONK_TEST: "HWeLrJqWKK3yDfqkGucGq9RpgfU75W1UE5iVL23BSw4Y",
} as const;

// Default export — points at devnet for now since active deploys target
// rome/rome. Switch to SPL_MINTS_MAINNET for mainnet.
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


/**
 * CCTP v2 destination-domain allowlist per Solana cluster, deployed into
 * RomeBridgeWithdraw v6's constructor (domain -> remote_token_messenger).
 * Devnet (testnet destinations): Ethereum-family/Sepolia 0, Avalanche Fuji 1,
 * Arbitrum Sepolia 3, Base Sepolia 6, Polygon Amoy 7, Monad Testnet 15 —
 * all six verified live on Circle's sandbox attester (2026-07-04).
 * Mainnet list stays conservative until a mainnet bridge chain exists.
 */
export const CCTP_V2_DOMAINS_DEVNET: number[] = [0, 1, 3, 6, 7, 15];
export const CCTP_V2_DOMAINS_MAINNET: number[] = [0];
