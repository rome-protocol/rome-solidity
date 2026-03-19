# `rome-solidity`

`rome-solidity` is a Solidity smart contract monorepo for SPL/EVM cross-program interaction primitives within Rome-EVM program stack, token utilities, and a Meteora DEX AMM implementation, tested via Hardhat.

## Key goals

- Solana-compatible token/account behavior in EVM style
- `Meteora DAMMv1`: automated market maker + factory/pool system
- Cross-program invocation wrappers (CPI)
- ERC20 SPL bridge and account helpers

---

## Repository structure

- contracts
  - `access_control.sol` - SPL ERC20 & permissions
  - `borsch.sol` - utility program primitive
  - `convert.sol` - currency/program conversions
  - `interface.sol` - CPI and SPL interface stubs
  - `rome_evm_account.sol` - account abstraction
  - `wcross_program_invocation.sol` - wrapped cross-program invocation test program
  - `wsystem_program.sol` - system program wrapper
  - `erc20spl/`
    - `erc20spl_factory.sol` - factory for SPL-mapped ERC20
    - `erc20spl.sol` - ERC20-SPL bridge token
  - `meteora/`
    - `damm_v1_factory.sol` - factory for DAMM v1 pools
    - `damm_v1_pool.sol` - AMM pair pool logic
  - `mpl_token_metadata/`
    - `lib.sol` - metadata helper for token metadata, MPL style
  - `spl_token/`
    - `associated_spl_token.sol` - associated token helper
    - `spl_token.sol` - SPL token primitives
- scripts
  - `deploy_meteora_factory.ts`
  - `deploy_meteora_pool.ts`
- hardhat.config.ts
- package.json, tsconfig.json
- artifacts, cache, deployments

---

## Quick start

### Requirements

- Node.js 18+ (recommended)
- npm / yarn
- Hardhat dependencies (installed by `npm install` below)

### Install

```bash
npm install
```

### Compile

```bash
npx hardhat compile
```

---

## Tests

Use Hardhat test suite:

```bash
npx hardhat test
```

Optionally run only specific sets (if configured by tag names or folder paths in tests):

```bash
npx hardhat test test/meteora
npx hardhat test test/erc20spl
```

---

## Deployment (local / chain)

Example scripts:
- deploy_meteora_factory.ts
- deploy_meteora_pool.ts

Run local network:

```bash
npx hardhat node
```

Deploy to local Hardhat RPC:

```bash
npx hardhat run scripts/deploy_meteora_factory.ts --network localhost
npx hardhat run scripts/deploy_meteora_pool.ts --network localhost
```

For external networks, configure API keys and accounts in hardhat.config.ts.

---

## Contract highlights

- `MeteoraDAMMv1Factory`
  - create pool factory
  - manage pool creation and fee config
- `DAMMv1Pool`
  - liquidity add/remove
  - swap with invariant
  - fee model
- `ERC20SPLFactory` + `SPL_ERC20`
  - minting/burning wrapped SPL tokens
  - bridging SPL tokens to ERC20 style

---

## Project policies

- Solidity currently targeted: 0.8.28
- Prefer non-reentrant checks and SafeMath semantics (built in)
- Maintain artifacts + `build-info` for deterministic testing
- Cross-program invocations encouraged through clean wrappers in `interface.sol`

---

## Contributing

1. Fork repo
2. branch `feature/<name>`
3. add/adjust tests
4. `npm test`
5. PR with explanation + gas/security notes

---

## Notes

- artifacts includes compiled JSON from existing snapshot builds.
- monti_spl.json is existing deployed contract metadata.
- Keep toolchain with hardhat.config.ts and `tsconfig` consistent with existing pattern.

---
