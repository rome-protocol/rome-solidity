# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
