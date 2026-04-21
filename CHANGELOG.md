# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Agent Execution Guide and Change Impact Map in CLAUDE.md
- PR and issue templates for standardized contributions
- CI pipeline with Hardhat compile and test stages

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
