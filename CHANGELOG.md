# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Unreleased

### Added — Rome Bridge Phase 1 (Solidity contracts)
- `contracts/bridge/RomeBridgePaymaster` — EIP-2771 trusted forwarder. Sponsors up to 3 Rome EVM transactions per user via a `(target, selector)` allowlist. Budget is only consumed when a request is actually dispatched (fixes `executeBatch` drain vector).
- `contracts/bridge/RomeBridgeWithdraw` — accepts rUSDC / rETH burn from a Rome EVM user, emits outbound Wormhole Token Bridge or CCTP `depositForBurn` messages via CPI signed as the user's Rome-derived PDA.
- `contracts/bridge/IWormholeTokenBridge.sol` — `WormholeTokenBridgeLib` with `transfer_tokens` instruction encoder and 18-account layout.
- `contracts/bridge/ICCTP.sol` — `CCTPLib` with `deposit_for_burn` instruction encoder and 13-account layout.
- `contracts/bridge/RomeBridgeEvents.sol` — shared `Withdrawn` and `PaymasterSponsored` events.
- `contracts/erc20spl/erc20spl.sol` — public `getAta(address user)` reader for the user's SPL token account.
- `scripts/bridge/deploy.ts` — deploy script for paymaster, SPL_ERC20 wrappers (rUSDC, rETH), and withdraw. All Solana pubkeys supplied at construction via `CctpParams` / `WormholeParams`.
- `scripts/bridge/derive/cctp-accounts.ts`, `scripts/bridge/derive/wormhole-accounts.ts` — PDA derivation helpers for the 14 Solana accounts required by `RomeBridgeWithdraw`.
- `scripts/lib/pubkey.ts` — `base58ToBytes32` helper.
- `tests/bridge/RomeBridgePaymaster.test.ts` — 11 unit tests on hardhatMainnet.
- `tests/bridge/RomeBridgeWithdraw.test.ts` — 7 error-path unit tests on hardhatMainnet.
- `tests/bridge/derive.test.ts` — 6 PDA-derivation unit tests.
- `tests/bridge/RomeBridgeWithdraw.integration.ts` — integration test scaffold; requires running local Rome stack or `monti_spl` devnet + seeded balances.

### Dependencies
- Added `@openzeppelin/contracts ^5.6.1` (for `ERC2771Forwarder`, `ERC2771Context`, `Ownable`).
- Added `bs58` (base58-to-bytes32 conversion in deploy scripts).
- Added `@solana/web3.js` (PDA derivation in deploy scripts).

### Spec
See `rome-product/specs/rome-bridge-phase1.md` for the full design spec (Variant B auto-redeem, USDC as Rome EVM gas token, Wormhole + CCTP sequencing).

## [Unreleased]

### Added
- Agent Execution Guide and Change Impact Map in CLAUDE.md
- PR and issue templates for standardized contributions
- CI pipeline with Hardhat compile and test stages
