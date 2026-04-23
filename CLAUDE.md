# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

rome-solidity is a Solidity smart contract repo for SPL/EVM cross-program interaction within the Rome-EVM program stack. It provides ERC20 wrappers for SPL tokens, a Meteora DAMM v1 AMM integration, and an Oracle Gateway V2 for Pyth Pull and Switchboard V3 price feeds, all running on Solana via Rome-EVM precompiles.

## Design principle (inherited from `/rome/CLAUDE.md`)

**Contracts expose Ethereum-standard interfaces.** External callers should not need to know they're talking to a Rome-specific contract. Enhance freely; don't degrade.

Contract-layer applications already baked in:

- **`SPL_ERC20` implements `IERC20` + `IERC20Metadata` exactly.** `transfer`, `transferFrom`, `approve`, `balanceOf`, `symbol`, `decimals` — standard ERC20 behavior. The CPI-to-SPL machinery is an implementation detail; external callers see a normal ERC20.
- **Oracle Gateway V2 adapters implement `AggregatorV3Interface`.** `latestRoundData()` returns Chainlink-normalized 8-decimal prices. A consumer written for Chainlink on Ethereum drops in without edits.
- **`IExtendedOracleAdapter` adds capability beyond the standard** (EMA, confidence, price-status) — a pure enhancement. Consumers that only want `AggregatorV3Interface` still work; consumers that need more can use the extension.
- **`wrap_gas_to_spl` / `unwrap_spl_to_gas` (when added) must mirror WETH9's `deposit()` / `withdraw()`.** Same call shape, same event semantics, same refund-on-excess-value behavior as Uniswap's canonical WETH. Don't invent a novel API.

When adding new contracts:

- **Start from the Ethereum canonical interface.** If a pattern exists on Ethereum (ERC20, ERC721, AggregatorV3, UniswapV2, etc.), use that interface. **Extend** in a separate `I<Thing>Extended.sol` — never modify the base interface, never replace it with a Rome-specific alternative.
- **Rome-specific helpers (CPI, PDA derivation, mint layout) go in `*_program.sol` / `*_lib.sol` modules**, not in the public contract surface. Keep the public surface EVM-standard.
- **Don't write "free to the user" primitives** (airdrop, faucet, subsidized mint). Token issuance goes through explicit bridge flows, swaps, or contract-owned admin — never zero-cost user claims.

**Reference spec**: [`rome-specs/active/technical/2026-04-23-gas-wrapper-split-at-bridge.md`](../rome-specs/active/technical/2026-04-23-gas-wrapper-split-at-bridge.md) — uses the ETH/WETH pattern as the anchor for gas-vs-wrapper decisions.

## Build & Test Commands

```bash
npm install                # install dependencies
npx hardhat compile        # compile all contracts (Solidity 0.8.28)

# Run tests (requires local Rome-EVM node or monti_spl network)
npx hardhat test tests/damm_v1_pool.integration.ts --network local

# Run oracle parser tests (uses hardhat simulated network)
npx hardhat test tests/oracle/PythPullParser.test.ts
npx hardhat test tests/oracle/SwitchboardParser.test.ts

# Deploy (requires env vars or hardhat keystore)
npx hardhat run scripts/deploy_meteora_factory.ts --network monti_spl
npx hardhat run scripts/deploy_meteora_pool.ts --network monti_spl

# Deploy Oracle Gateway V2
npx hardhat run scripts/oracle/deploy.ts --network monti_spl
npx hardhat run scripts/oracle/deploy-factory.ts --network monti_spl
npx hardhat run scripts/oracle/deploy-and-test.ts --network monti_spl  # end-to-end deploy + test

# Test oracle feeds on live network
npx hardhat run scripts/oracle/test-feeds.ts --network monti_spl       # Pyth v1 feeds
npx hardhat run scripts/oracle/test-feeds-v2.ts --network monti_spl    # Oracle Gateway V2 (Pyth Pull + batch reader)
npx hardhat run scripts/oracle/test-switchboard.ts --network monti_spl # Switchboard V2 feeds

# Validate oracle parser offsets against live accounts
npx hardhat run scripts/oracle/validate-pyth-pull-offsets.ts --network monti_spl
npx hardhat run scripts/oracle/validate-switchboard-offsets.ts --network monti_spl

# Debug/inspect oracle accounts
npx hardhat run scripts/oracle/check-account-owner.ts --network monti_spl
npx hardhat run scripts/oracle/check-switchboard.ts --network monti_spl

# Local Rome stack setup (requires rome-setup stack running)
npx hardhat keystore set LOCAL_PRIVATE_KEY --dev   # Hardhat #0: ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
npx hardhat run scripts/setup-local.ts --network local  # deploys Meteora factory+pool, Oracle Gateway V2, Pyth+Switchboard feeds

# Run integration tests against local stack
npx hardhat test tests/damm_v1_pool.integration.ts --network local
npx hardhat run scripts/oracle/test-switchboard.ts --network local
npx hardhat run scripts/oracle/test-feeds-v2.ts --network local

# Set keys in dev keystore
npx hardhat keystore set MONTI_SPL_PRIVATE_KEY --dev
```

## CI & Release Tracking

- **CI** (`.github/workflows/ci.yml`): runs on push/PR to `master` with Node 22. Stages: `npm ci`, `npx hardhat compile`, `npx hardhat test` (oracle parser unit tests — network-independent). Integration tests requiring `local` or `monti_spl` are not run in CI.
- **CHANGELOG.md** — user-facing changes tracked by session. Update when a PR lands user-visible behaviour changes (new contracts, API shifts, deployment changes). Parser/offset changes also belong here because they affect downstream deployments.
- **PR / issue templates** live under `.github/` and enforce the session-readiness checklist.

## Architecture

### Rome-EVM Precompile Interfaces (`contracts/interface.sol`)

The core abstraction layer. Rome-EVM exposes Solana programs as EVM precompiles at fixed addresses:

| Precompile | Address | Interface |
|---|---|---|
| SPL Token | `0xff..05` | `ISplToken` — token account state, transfers, init (**legacy**: no longer a dedicated handler in rome-evm-private; routed via Mollusk SVM/CPI) |
| Associated Token | `0xff..06` | `IAssociatedSplToken` — ATA creation (**legacy**: no longer a dedicated handler in rome-evm-private; routed via Mollusk SVM/CPI) |
| System Program | `0xff..07` | `ISystemProgram` — PDA derivation, account creation, base58 conversion |
| CPI | `0xff..08` | `ICrossProgramInvocation` — arbitrary Solana CPI from EVM |
| Withdraw | `0x42..16` | `IWithdraw` — SOL withdrawal |

Global constants (`SplToken`, `AssociatedSplToken`, `SystemProgram`, `CpiProgram`, `Withdraw`) are pre-bound instances. Note: as of the rome-evm-private Mollusk refactor, `SplToken` and `AssociatedSplToken` no longer have dedicated precompile handlers — SPL operations are executed via Mollusk SVM in the emulator and CPI on-chain.

### Contract Layers

- **`contracts/spl_token/`** — Low-level SPL token and associated token account libraries (`SplTokenLib`, `AssociatedSplTokenLib`). These use `CpiProgram.account_info()` to deserialize on-chain Solana account data (Borsh-encoded) from within Solidity.
- **`contracts/erc20spl/`** — `SPL_ERC20` wraps an SPL mint as an ERC20 token with deposit/withdraw. `ERC20SPLFactory` deploys these wrappers. Uses OpenZeppelin IERC20.
- **`contracts/meteora/`** — `MeteoraDAMMv1Factory` and `DAMMv1Pool` implement a Uniswap-style factory/pool pattern that delegates swaps to Meteora's on-chain Solana program via CPI.
- **`contracts/oracle/`** — Oracle Gateway V2: Chainlink-compatible adapters for both Pyth Pull and Switchboard V3 price feeds. `OracleAdapterFactory` deploys `PythPullAdapter` and `SwitchboardV3Adapter` instances via EIP-1167 minimal proxy clones. Each adapter reads Solana account data via CPI precompile, parses Borsh-encoded price data (`PythPullParser` / `SwitchboardParser`), and normalizes to 8-decimal Chainlink format. `IExtendedOracleAdapter` extends `IAggregatorV3Interface` with confidence intervals, EMA data, and price status. `BatchReader` reads multiple feeds in one call. The factory includes owner-controlled pause/unpause emergency controls. Includes `examples/SampleLendingOracle.sol`.
- **`contracts/bridge/`** — Rome Bridge Phase 1 (Solana ↔ Ethereum cross-chain). `RomeBridgePaymaster` is an EIP-2771 trusted forwarder with per-user 3-tx sponsorship cap + (target, selector) allowlist. `RomeBridgeWithdraw` accepts ERC-20 input on Rome EVM and emits Wormhole Token Bridge or CCTP outbound messages via CPI signed as the user's PDA. Outbound Wormhole is split across two EVM txs (`approveBurnETH` then `burnETH`) because a single atomic Rome DoTx with two CPIs exceeds Solana's 1.4M compute-unit budget. `IWormholeTokenBridge.sol` and `ICCTP.sol` encode the native/Anchor Solana instructions. All Solana pubkeys are supplied via constructor params so the contract is network-agnostic. **See `contracts/bridge/README.md`** for architecture, flow diagrams, and a problems-and-fixes runbook covering the incidents from bring-up. Design spec: `rome-product/specs/rome-bridge-phase1.md`.
- **`contracts/system_program/`** — Solana System Program helpers. `instruction_data.sol` encodes System Program instructions (create account, transfer, assign, nonce operations, allocate) as little-endian bytes. `system_program.sol` wraps these as CPI calls.
- **`contracts/mpl_token_metadata/`** — Deserializes Metaplex Token Metadata V2 accounts from Borsh-encoded binary. Parses creators, token standards, collection details, uses, and programmable config. Provides `find_metadata_pda()` and `load_metadata()`.
- **`contracts/rome_evm_account.sol`** — PDA derivation helpers for Rome-EVM user accounts (maps `address` → Solana `bytes32` pubkey).
- **`contracts/access_control.sol`** — Owner-gated access control used by `SPL_ERC20` and `SplHolder` contracts.
- **`contracts/convert.sol`** — Little-endian deserialization utilities (`Convert` library) for reading Borsh-encoded Solana account data: `u8`, `u32le`, `u64le`, `i64le`, `i128le`, `bytes32`, and `COption<Pubkey>`.
- **`contracts/borsch.sol`** — Legacy Borsh deserialization utilities (used by older contracts).
- **`contracts/wsystem_program.sol`** — Wrapper around the System Program precompile for `program_id()`, `rome_evm_program_id()`, `pda()`, `allocate()`, and `assign()`.
- **`contracts/wcross_program_invocation.sol`** — Example: calling an arbitrary Solana program from EVM via CPI.
- **`contracts/examples/orra.sol`** — Integration example for the Orra program demonstrating CPI with signed invocations, PDA derivation with seeds, and sub-account management.

### Key Patterns

- Solana pubkeys are `bytes32` throughout; EVM addresses map to Solana PDAs via `RomeEVMAccount.pda(address)`.
- Cross-program invocation uses `ICrossProgramInvocation.invoke()` / `invoke_signed()` with Solana-style `AccountMeta` arrays.
- Borsh deserialization (`BorshLib`) decodes raw Solana account data returned by `CpiProgram.account_info()`.
- Deployment metadata is stored in `deployments/monti_spl.json` and consumed by tests via `scripts/lib/deployments.ts`. Local deployment artifacts (`deployments/local.json`, cached account data) are gitignored.
- Oracle adapters use EIP-1167 minimal proxy (clone) pattern — one implementation contract per oracle type, thin clones per feed. Factory validates Solana account ownership before deploying.
- Parser offsets are validated against live Solana accounts using `scripts/oracle/validate-*-offsets.ts` scripts. Always re-validate before redeployment.
- Oracle test harnesses (`contracts/oracle/test/`) expose internal parser functions for unit testing. Parser tests use mock account data (`tests/oracle/helpers/`).
- **Internal overload trap:** when a contract has both an external multi-arg overload and an internal 3-arg overload (e.g. `invoke_swap`), call the internal one **without** `this.`. `this.foo()` forces an external call, which resolves to the external overload and fails to compile. Observed on `DAMMv1Pool.invoke_swap` (#23).

### Deployments

Deployment metadata is tracked in `deployments/{network}.json`. `marcus.json` and `monti_spl.json` are committed (devnet deployments); `local.json` is generated by `scripts/setup-local.ts` and should not be committed (regenerated per local stack restart). Current devnet deployments:

**marcus (current V2 target):**
- **OracleGatewayV2** — PythPullAdapter + SwitchboardV3Adapter implementations, OracleAdapterFactory (`defaultMaxStaleness=300`), BatchReader, + 5 Pyth feeds (SOL/BTC/ETH/USDC/USDT) and 1 Switchboard feed (SOL). Deployed by `scripts/oracle/deploy-v2-polish.ts` (idempotent — set `FORCE_REDEPLOY=1` to override).
- **MeteoraDAMMv1Factory**, **RomeBridgePaymaster**, **RomeBridgeWithdraw**, **SPL_ERC20** (rUSDC, rETH) — Rome Bridge Phase 1 wrappers.

**monti_spl (retired):**
- **OracleGatewayV2Legacy** — historical V2 addresses kept for reference only; monti_spl is no longer a deploy target.
- **MeteoraDAMMv1Factory**, **PythAggregatorFactory**, **PythAggregatorFeeds** — legacy artifacts.

### Networks

- `local` — local Rome-EVM node at `http://localhost:9090` (key: `LOCAL_PRIVATE_KEY`)
- `monti_spl` — Rome devnet at `https://montispl-i.devnet.romeprotocol.xyz/` (key: `MONTI_SPL_PRIVATE_KEY`)
- `sepolia` — Ethereum Sepolia testnet (key: `SEPOLIA_PRIVATE_KEY`)
- `hardhatMainnet` — Hardhat EDR simulated L1 network (used for oracle parser unit tests)
- `hardhatOp` — Hardhat EDR simulated OP Stack network

### Solidity Version

Target: `0.8.28`. Production profile enables optimizer with 200 runs.

## Agent Execution Guide

- All contracts consume precompile interfaces from `rome-solidity-sdk` (../rome-solidity-sdk/).
- After modifying precompile addresses or ABIs, verify consumers compile: `npx hardhat compile`.
- Test against local Rome-EVM node first: `npx hardhat test --network local`.
- Test against devnet: `npx hardhat test --network montispl`.
- Oracle Gateway V2 contracts depend on live Pyth/Switchboard feeds — test against montispl for oracle-related changes.
- Never deploy contracts without running the full Hardhat test suite.
- ERC-20 SPL wrappers interact with Solana precompiles at fixed addresses — verify precompile addresses match rome-evm-private if changed. Note: SPL Token (0xFF...05) and Associated Token (0xFF...06) dedicated handlers were removed in the Mollusk refactor; these now route through Mollusk SVM/CPI.
- Update `CHANGELOG.md` when a PR lands user-visible behaviour changes or changes the deployed contract ABIs.

## Change Impact Map

| If you change... | Also check/update... |
|-----------------|---------------------|
| Precompile interface addresses | `rome-solidity-sdk/` interfaces must match `rome-evm-private/` precompile dispatch |
| Contract ABIs | `rome-deposit-ui/` ABI imports, `tests/` Solidity test contracts, `CHANGELOG.md` |
| Oracle adapter interfaces | Consuming contracts in this repo that use the adapters |
| SPL token wrapper logic | `rome-uniswap-v2/` (uses SPL wrappers for trading pairs) |
| Hardhat network config | `rome-solidity-sdk/` uses same network definitions |

## Test Selection Guide

| What Changed | Tests to Run |
|-------------|-------------|
| Any contract | `npx hardhat test` (full suite) |
| Oracle contracts | `npx hardhat test` + `npx hardhat test --network montispl` (verify live feeds) |
| Precompile wrappers | `npx hardhat test` + `tests/` opcode suite in integration repo |
| ERC-20 SPL wrappers | `npx hardhat test` + `tests/` EVM suite |
| Hardhat config only | `npx hardhat compile` (verify config is valid) |
