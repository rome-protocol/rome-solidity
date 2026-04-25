# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Unreleased

### Added — Oracle Gateway V2 GitHub Actions deploy workflow
- `.github/workflows/deploy-oracle.yml` — manual-trigger (`workflow_dispatch`) workflow that deploys Oracle Gateway V2 (core + seed feeds + verification) against a selected Rome devnet using a single shared GitHub Secret (`ROME_DEVNET_PRIVATE_KEY`). Posts the resulting `deployments/<network>.json` back as a reviewable bot PR via `peter-evans/create-pull-request` when `open_pr: true`. Toggles: `run_seed_feeds`, `run_verification`, `open_pr`, `force_redeploy`. Closes #33.
- `hardhat.config.ts` — added `subura` (chainId 121222) and `esquiline` (chainId 121225) network entries; deduplicated the `marcus` block and added its explicit `chainId 121226`.
- `README.md` — new "Deploy Oracle Gateway V2 via GitHub Actions" section documenting the required secret and trigger flow.

### Changed — Oracle Gateway V2 deploy scripts: idempotency + naming
- `scripts/oracle/deploy-v2-polish.ts` — now idempotent. If `deployments/<network>.json` already contains a populated `OracleGatewayV2` block, the script prints existing addresses and exits without deploying. Set `FORCE_REDEPLOY=1` to override. Previously every invocation redeployed unconditionally, which wasted gas and orphaned the prior deploy on every CI run.
- Deploy block renamed: `OracleGatewayV2Polished` → `OracleGatewayV2`. The "Polished" suffix existed only because a parallel legacy `OracleGatewayV2` block was being preserved during the audit refactor; that block is now an artifact and has been renamed to `OracleGatewayV2Legacy` in `deployments/monti_spl.json` (the only file that carried it; `monti_spl` itself is retired). `deploy-seed-feeds.ts` and `test-feeds-v2.ts` updated to the new name. `test-feeds-v2.ts` also fixed to read the current plain-string address shape (previously still expected the old `{address: "0x..."}` nesting from `deploy.ts`).
- `deployments/marcus.json` — block renamed. Addresses refreshed by a dry-run of the workflow against `marcus`; **downstream consumers (rome-oracle-portal, etc.) must update their marcus V2 addresses**.

### Changed — Rome Bridge Phase 1 outbound Wormhole target chain
- `contracts/bridge/RomeBridgeWithdraw` — added `wormholeTargetChain` immutable constructor param; `burnETH` now uses that instead of a hardcoded `2`. Wormhole testnet Sepolia is chain id 10002, not 2 (which is Ethereum mainnet). Without this, outbound VAAs targeted the wrong chain and the Sepolia Token Bridge refused to redeem them with `"invalid target chain"`.
- `scripts/bridge/deploy.ts`, `redeploy-withdraw-devnet-wh.ts`, `redeploy-withdraw-canonical-weth.ts` — set `targetChain: 10002` for marcus/local (Sepolia). `redeploy-withdraw-only.ts` sets `targetChain: 2` for the mainnet path.
- `scripts/bridge/outbound-wh-e2e.ts`, `scripts/bridge/e2e-all-four.ts` — full end-to-end runners (source burn, Solana sig lookup, VAA/attestation poll, destination redemption).

### Changed — Rome Bridge Phase 1 bring-up fixes (marcus devnet)
- `contracts/bridge/RomeBridgeWithdraw` — split outbound Wormhole into two EVM txs: new `approveBurnETH(uint256)` does the SPL Token Approve CPI; existing `burnETH(uint256,address)` now does only `transfer_wrapped`. Single-tx flow exceeded Solana's 1.4M compute-unit budget (Rome DoTx overhead ~1.3M CU leaves too little for Wormhole + SPL Token burn). Matches the standard "approve then bridge" pattern.
- `scripts/bridge/constants.ts` — `SPL_MINTS_DEVNET.WETH_WORMHOLE` updated to the canonical wrapped-Sepolia-ETH mint `6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs` (was a stale test mint `2kCwKG…`). Derived from `deriveCanonicalWrappedMint({ tokenChain: 10002, tokenAddress: "eef12a83…" })` and verified on chain. Keeps `wrappedMeta` PDA in sync with the deployed rETH wrapper; stops Wormhole returning "Unexpected length of input" on an empty PDA.
- `scripts/bridge/submit-burnETH.ts` — sends `approveBurnETH` then `burnETH` (two-step E2E). Reads addresses from `deployments/marcus.json`.

### Added — Bridge setup + diagnostics
- `contracts/bridge/README.md` — architecture overview, flow diagrams, and a problems-and-fixes runbook (8 real incidents with root cause and fix), redeploy procedure.
- `scripts/bridge/allowlist-approve-selector.ts` — one-shot that allowlists `approveBurnETH(uint256)` on the paymaster for the current `RomeBridgeWithdraw`. Run after redeploy so ERC-2771 sponsorship works for the two-step outbound Wh flow.
- `scripts/bridge/smoke-emulate-all.ts` — verifies `burnUSDC` and `approveBurnETH` emulate cleanly on the current deployment.

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

## 2026-04-21 — Oracle Gateway V2 Security Hardening + Marcus Redeploy

### Changed
- **Redeployed** Oracle Gateway V2 stack on `marcus` devnet with `defaultMaxStaleness=86400` (24h). Previous 60-second window bricked every feed read because Pyth price accounts on Solana devnet are not published to frequently enough. New addresses in `deployments/marcus.json`:
  - `OracleAdapterFactory` → `0x454f0cde265ecf530a01c5c1bfd1f40d9e0672af`
  - `PythPullAdapterImpl` → `0x23f27d84c5fd53a32baaa52270a22f7b13f241da`
  - `SwitchboardV3AdapterImpl` → `0x827a045a8fd1973859ac57df8e801e658e9ed78b`
  - `BatchReader` → `0x0796e4cfdba2acb9aab32abd1722e7845c87acf1`
  - 5 Pyth feeds (SOL/BTC/ETH/USDC/USDT) + 1 Switchboard SOL/USD seeded.
- **Switchboard V2 vs V3 naming.** All NatSpec and parser comments now consistently say "Switchboard V2 (`SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f`)". Contract filename `SwitchboardV3Adapter.sol` retained for back-compat with ABI caches and deploy scripts; rename to `SwitchboardV2Adapter` is tracked as a follow-up.

### Fixed — Security audit findings (PR #30)

- **C-1** Implementation contracts (`PythPullAdapter`, `SwitchboardV3Adapter`) are now locked from direct `initialize()` calls via `initialized = true` in the constructor. Prevents an attacker from setting the implementation's factory address to an attacker-controlled contract.
- **C-2** `OracleAdapterFactory.transferOwnership(address(0))` now reverts with `ZeroAddress`. Prevents single-step brick-by-typo.
- **H-1** Staleness check in both adapters no longer panics when Solana clock is slightly ahead of EVM clock. `if (publishTime > block.timestamp || block.timestamp - publishTime > maxStaleness) revert StalePriceFeed()`.
- **H-3** `PythPullAdapter.latestRoundData()` rejects prices with confidence interval exceeding 2% of price (`MAX_CONF_BPS = 200`). New error `ConfidenceExceedsThreshold`. Also added defensive `price > 0` guard in `_checkConfidence`.
- **H-4** `pauseAdapter` / `unpauseAdapter` now require the target to be in the new `isRegisteredAdapter` mapping. New error `AdapterNotRegistered`.
- **M-1** `PythPullParser` rejects non-`Full` verification variants at byte offset 40. New error `UnsupportedVerificationVariant`. Prevents silently-shifted garbage prices from `Partial`-variant accounts.
- **M-5** Adapter stores `expectedProgramId` from `initialize()` and revalidates the account owner on every `_readAndParse()`. Previously owner was checked only at `createFeed`. New error `AccountOwnerChanged`.

### Added

- 6 new test files under `tests/oracle/`: `ImplementationLock`, `FactoryOwnership`, `StalenessUnderflow`, `PythConfidence`, `FactoryPauseRegistry`, `AccountOwnerRevalidation`. Total oracle test count: **70 passing**, up from 35.
- 3 new test harnesses under `contracts/oracle/test/`: `AdapterCloneFactory`, `StalenessHarness`, `AccountOwnerHarness`. Used for exercising internal helpers and mocking CPI responses in the simulated network.
- `contracts/oracle/README.md` — architecture overview, deployment table, consumer usage, security model.

### Known

- CI (`.github/workflows/ci.yml`) invokes `npx hardhat test` which runs only the Solidity-test runner — the `node:test` suite requires `npx hardhat test nodejs tests/oracle/*.test.ts`. **Zero oracle tests currently run in CI.** Tracked as a separate workflow PR.
- Remaining audit items deferred to a second security PR: H-2 (int256→int64 truncation), M-2 (exponent overflow DoS), M-3 (Switchboard negative timestamp), M-4 (BatchReader blanket catch), L-1 (dead OnlyFactory error), L-2 (unbounded allAdapters).

## 2026-04-20 — Oracle Gateway V2 Polish

### Added
- `IAdapterMetadata` interface with `OracleSource` enum (Pyth=0, Switchboard=1).
- `metadata()` view on `PythPullAdapter` and `SwitchboardV3Adapter` returning description, sourceType, Solana account, maxStaleness, `createdAt`, factory address, and live paused state in a single struct. Removes the need for off-chain event indexing to describe a feed.
- `BatchReader.getFeedHealth(address[])` returning per-feed `FeedHealth` with aggregated healthy/stale/paused status, latest price, and time since update. Uses per-adapter try/catch isolation plus a codeless-address short-circuit so one broken feed does not poison the batch.
- Staleness bounds `[1s, 24h]` enforced across the factory (constructor + `setDefaultMaxStaleness`) and both adapter `initialize()` methods. New error `StalenessOutOfRange(uint256)`.
- Fuzz tests for `PythPullParser` and `SwitchboardParser` — 50 random byte-mutation iterations per parser verify the parse-or-revert property (no silent garbage returns).
- Inline derivation comments for the Pyth (`0x22f123639d7ef4cd`) and Switchboard (`0xd9e64165c9a21b7d`) Anchor discriminators.
- GitHub Actions workflow `oracle-offset-validation.yml` running Pyth + Switchboard parser offset validation on every PR touching `contracts/oracle/**` and weekly on Mondays at 00:00 UTC. Slack alert on cron failure.
- `marcus` devnet network in `hardhat.config.ts` (chainId 121226, endpoint `https://marcus.devnet.romeprotocol.xyz`).
- Deployment scripts `scripts/oracle/deploy-v2-polish.ts` and `scripts/oracle/deploy-seed-feeds.ts` — coordinated redeploy + idempotent seed rollout per `--network`.

### Changed
- Polished Oracle Gateway V2 stack redeployed on `marcus` devnet under `OracleGatewayV2Polished` in `deployments/marcus.json`:
  - `OracleAdapterFactory` → `0x0164b98c1e9d9d25f4c9d3f617d1aaf5ca28efce`
  - `PythPullAdapterImpl` → `0xc91f5528b1529e0b2ca2b89b5c5632acad88bc09`
  - `SwitchboardV3AdapterImpl` → `0xebf4695cd79f2ec4cf36861bcc0b59c6d1a630d8`
  - `BatchReader` → `0x83d32d9a70dfc02fadcffff2d5d7f8d3c03fb314`
- Seeded 5 Pyth feeds (SOL/USD, BTC/USD, ETH/USD, USDC/USD, USDT/USD) and 1 Switchboard feed (SOL/USD) on marcus.

### Deprecated
- Prior `OracleGatewayV2` block in `deployments/monti_spl.json` — `monti_spl` devnet has been retired. `marcus` is the current development target. Legacy addresses remain on-chain at `monti_spl` but are no longer tracked.
