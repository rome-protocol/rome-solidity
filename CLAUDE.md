# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

rome-solidity is a Solidity smart contract repo for SPL/EVM cross-program interaction within the Rome-EVM program stack. It provides ERC20 wrappers for SPL tokens, a Meteora DAMM v1 AMM integration, and an Oracle Gateway for Pyth price feeds, all running on Solana via Rome-EVM precompiles.

## Build & Test Commands

```bash
npm install                # install dependencies
npx hardhat compile        # compile all contracts (Solidity 0.8.28)

# Run tests (requires local Rome-EVM node or monti_spl network)
npx hardhat test tests/damm_v1_pool.integration.ts --network local

# Run oracle tests (uses hardhat mainnet fork)
npx hardhat test tests/pyth_parser.test.ts
npx hardhat test tests/normalizer.test.ts

# Deploy (requires env vars or hardhat keystore)
npx hardhat run scripts/deploy_meteora_factory.ts --network monti_spl
npx hardhat run scripts/deploy_meteora_pool.ts --network monti_spl

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
- **`contracts/oracle/`** — Solana Oracle Gateway: Chainlink-compatible adapters for Pyth price feeds. `PythAggregatorFactory` permissionlessly deploys `PythAggregatorV3` adapters (one per Pyth feed). Each adapter reads Pyth account data from Solana via CPI, parses Borsh-encoded price data (`PythParser`), and normalizes to 8-decimal Chainlink format. Implements `IAggregatorV3Interface` so any EVM DeFi protocol can consume Pyth oracles without integration changes. Includes `examples/SampleLendingOracle.sol`.
- **`contracts/rome_evm_account.sol`** — PDA derivation helpers for Rome-EVM user accounts (maps `address` → Solana `bytes32` pubkey).
- **`contracts/borsch.sol`** — Borsh deserialization utilities for reading Solana account data.
- **`contracts/wcross_program_invocation.sol`** — Example: calling an arbitrary Solana program from EVM via CPI.

### Key Patterns

- Solana pubkeys are `bytes32` throughout; EVM addresses map to Solana PDAs via `RomeEVMAccount.pda(address)`.
- Cross-program invocation uses `ICrossProgramInvocation.invoke()` / `invoke_signed()` with Solana-style `AccountMeta` arrays.
- Borsh deserialization (`BorshLib`) decodes raw Solana account data returned by `CpiProgram.account_info()`.
- Deployment metadata is stored in `deployments/monti_spl.json` and consumed by tests via `scripts/lib/deployments.ts`.

### Networks

- `local` — local Rome-EVM node at `http://localhost:9090`
- `monti_spl` — Rome devnet at `https://montispl-i.devnet.romeprotocol.xyz/`
- `sepolia` — Ethereum Sepolia testnet
- `hardhatMainnet` — Hardhat mainnet fork (used for oracle unit tests)

### Solidity Version

Target: `0.8.28`. Production profile enables optimizer with 200 runs.
