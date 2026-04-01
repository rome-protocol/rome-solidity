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

# Validate oracle parser offsets against live accounts
npx hardhat run scripts/oracle/validate-pyth-pull-offsets.ts --network monti_spl
npx hardhat run scripts/oracle/validate-switchboard-offsets.ts --network monti_spl

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
- **`contracts/erc20spl/`** — `SPL_ERC20` wraps an SPL mint as an ERC20 token. `ERC20SPLFactory` deploys these wrappers. Uses OpenZeppelin IERC20.
- **`contracts/meteora/`** — `MeteoraDAMMv1Factory` and `DAMMv1Pool` implement a Uniswap-style factory/pool pattern that delegates swaps to Meteora's on-chain Solana program via CPI.
- **`contracts/oracle/`** — Oracle Gateway V2: Chainlink-compatible adapters for both Pyth Pull and Switchboard V3 price feeds. `OracleAdapterFactory` deploys `PythPullAdapter` and `SwitchboardV3Adapter` instances via EIP-1167 minimal proxy clones. Each adapter reads Solana account data via CPI precompile, parses Borsh-encoded price data (`PythPullParser` / `SwitchboardParser`), and normalizes to 8-decimal Chainlink format. `IExtendedOracleAdapter` extends `IAggregatorV3Interface` with confidence intervals, EMA data, and price status. `BatchReader` reads multiple feeds in one call. The factory includes owner-controlled pause/unpause emergency controls. Includes `examples/SampleLendingOracle.sol`.
- **`contracts/rome_evm_account.sol`** — PDA derivation helpers for Rome-EVM user accounts (maps `address` → Solana `bytes32` pubkey).
- **`contracts/convert.sol`** — Little-endian deserialization utilities (`Convert` library) for reading Borsh-encoded Solana account data: `u8`, `u32le`, `u64le`, `i64le`, `i128le`, `bytes32`, and `COption<Pubkey>`.
- **`contracts/borsch.sol`** — Legacy Borsh deserialization utilities (used by older contracts).
- **`contracts/wcross_program_invocation.sol`** — Example: calling an arbitrary Solana program from EVM via CPI.

### Key Patterns

- Solana pubkeys are `bytes32` throughout; EVM addresses map to Solana PDAs via `RomeEVMAccount.pda(address)`.
- Cross-program invocation uses `ICrossProgramInvocation.invoke()` / `invoke_signed()` with Solana-style `AccountMeta` arrays.
- Borsh deserialization (`BorshLib`) decodes raw Solana account data returned by `CpiProgram.account_info()`.
- Deployment metadata is stored in `deployments/monti_spl.json` and consumed by tests via `scripts/lib/deployments.ts`.
- Oracle adapters use EIP-1167 minimal proxy (clone) pattern — one implementation contract per oracle type, thin clones per feed. Factory validates Solana account ownership before deploying.
- Parser offsets are validated against live Solana accounts using `scripts/oracle/validate-*-offsets.ts` scripts. Always re-validate before redeployment.
- Oracle test harnesses (`contracts/oracle/test/`) expose internal parser functions for unit testing. Parser tests use mock account data (`tests/oracle/helpers/`).

### Networks

- `local` — local Rome-EVM node at `http://localhost:9090`
- `monti_spl` — Rome devnet at `https://montispl-i.devnet.romeprotocol.xyz/`
- `sepolia` — Ethereum Sepolia testnet
- `hardhatMainnet` — Hardhat simulated L1 network (used for oracle parser unit tests)

### Solidity Version

Target: `0.8.28`. Production profile enables optimizer with 200 runs.
