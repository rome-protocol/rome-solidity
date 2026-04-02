# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

rome-solidity is a Solidity smart contract repo for SPL/EVM cross-program interaction within the Rome-EVM program stack. It provides ERC20 wrappers for SPL tokens, a Meteora DAMM v1 AMM integration, and an Oracle Gateway V2 for Pyth Pull and Switchboard V3 price feeds, all running on Solana via Rome-EVM precompiles.

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

# Set keys in dev keystore
npx hardhat keystore set MONTI_SPL_PRIVATE_KEY --dev
```

## Architecture

### Rome-EVM Precompile Interfaces (`contracts/interface.sol`)

The core abstraction layer. Rome-EVM exposes Solana programs as EVM precompiles at fixed addresses:

| Precompile | Address | Interface |
|---|---|---|
| SPL Token | `0xff..05` | `ISplToken` — token account state, transfers, init |
| Associated Token | `0xff..06` | `IAssociatedSplToken` — ATA creation |
| System Program | `0xff..07` | `ISystemProgram` — PDA derivation, account creation, base58 conversion |
| CPI | `0xff..08` | `ICrossProgramInvocation` — arbitrary Solana CPI from EVM |
| Withdraw | `0x42..16` | `IWithdraw` — SOL withdrawal |

Global constants (`SplToken`, `AssociatedSplToken`, `SystemProgram`, `CpiProgram`, `Withdraw`) are pre-bound instances.

### Contract Layers

- **`contracts/spl_token/`** — Low-level SPL token and associated token account libraries (`SplTokenLib`, `AssociatedSplTokenLib`). These use `CpiProgram.account_info()` to deserialize on-chain Solana account data (Borsh-encoded) from within Solidity.
- **`contracts/erc20spl/`** — `SPL_ERC20` wraps an SPL mint as an ERC20 token with deposit/withdraw. `ERC20SPLFactory` deploys these wrappers. Uses OpenZeppelin IERC20.
- **`contracts/meteora/`** — `MeteoraDAMMv1Factory` and `DAMMv1Pool` implement a Uniswap-style factory/pool pattern that delegates swaps to Meteora's on-chain Solana program via CPI.
- **`contracts/oracle/`** — Oracle Gateway V2: Chainlink-compatible adapters for both Pyth Pull and Switchboard V3 price feeds. `OracleAdapterFactory` deploys `PythPullAdapter` and `SwitchboardV3Adapter` instances via EIP-1167 minimal proxy clones. Each adapter reads Solana account data via CPI precompile, parses Borsh-encoded price data (`PythPullParser` / `SwitchboardParser`), and normalizes to 8-decimal Chainlink format. `IExtendedOracleAdapter` extends `IAggregatorV3Interface` with confidence intervals, EMA data, and price status. `BatchReader` reads multiple feeds in one call. The factory includes owner-controlled pause/unpause emergency controls. Includes `examples/SampleLendingOracle.sol`.
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
- Deployment metadata is stored in `deployments/monti_spl.json` and consumed by tests via `scripts/lib/deployments.ts`.
- Oracle adapters use EIP-1167 minimal proxy (clone) pattern — one implementation contract per oracle type, thin clones per feed. Factory validates Solana account ownership before deploying.
- Parser offsets are validated against live Solana accounts using `scripts/oracle/validate-*-offsets.ts` scripts. Always re-validate before redeployment.
- Oracle test harnesses (`contracts/oracle/test/`) expose internal parser functions for unit testing. Parser tests use mock account data (`tests/oracle/helpers/`).

### Deployments

Deployment metadata is tracked in `deployments/monti_spl.json`. Current deployments on monti_spl:
- **MeteoraDAMMv1Factory** — Factory + 2 pool deployments with SPL token pubkeys and EVM addresses
- **PythAggregatorFactory** — Pyth v1 feed factory (legacy)
- **PythAggregatorFeeds** — SOL/USD, BTC/USD, ETH/USD Pyth v1 adapters
- **OracleGatewayV2** — PythPullAdapter, SwitchboardV3Adapter implementations, OracleAdapterFactory (defaultMaxStaleness=60), BatchReader, and SwitchboardFeeds (SOL/USD)

### Networks

- `local` — local Rome-EVM node at `http://localhost:9090` (key: `LOCAL_PRIVATE_KEY`)
- `monti_spl` — Rome devnet at `https://montispl-i.devnet.romeprotocol.xyz/` (key: `MONTI_SPL_PRIVATE_KEY`)
- `sepolia` — Ethereum Sepolia testnet (key: `SEPOLIA_PRIVATE_KEY`)
- `hardhatMainnet` — Hardhat EDR simulated L1 network (used for oracle parser unit tests)
- `hardhatOp` — Hardhat EDR simulated OP Stack network

### Solidity Version

Target: `0.8.28`. Production profile enables optimizer with 200 runs.
