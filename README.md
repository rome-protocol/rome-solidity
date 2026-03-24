# `rome-solidity`

`rome-solidity` is a Solidity smart contract monorepo for SPL/EVM cross-program interaction primitives within Rome-EVM program stack, token utilities, and a Meteora DEX AMM implementation, tested via Hardhat.

## Key goals

- Solana-compatible token/account behavior in EVM style
- `Meteora DAMMv1`: automated market maker + factory/pool system
- Cross-program invocation wrappers (CPI)
- ERC20 interface to SPL tokens

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

# Meteora DAMMv1 integration

This integration can be used as an example of how Rome-EVM can provide interoperability with native Solana smart-contracts.

## Preparation

1. Go to https://devnet.meteora.ag/pools#dynamicpools and find Meteora **DAMMv1** pool which your would like to use from within Rome-EVM
2. Copy the address of this pool (base58) and convert it into HEX. Later we will refer to this address as *POOL_ADDRESS*

## Deployment

Example scripts:
- deploy_meteora_factory.ts
- deploy_meteora_pool.ts

```bash
export MONTI_SPL_PRIVATE_KEY=<YOUR_PRIVATE_KEY>
export POOL_ADDRESS=<YOUR_POOL_ADDRESS>
npx hardhat run scripts/deploy_meteora_factory.ts --network monti_spl
npx hardhat run scripts/deploy_meteora_pool.ts --network monti_spl
```

After successfull deployment, you will see new file /deployments/monti_spl.json
Wich contains information about deployed smart contracts. This file later is used by tests

---

## Tests

Set tester private key in dev keystore:

```bash
npx hardhat keystore set MONTI_SPL_PRIVATE_KEY --dev
```

Use Hardhat test suite:

```bash
npx hardhat test tests/damm_v1_pool.integration.ts --network local
```

## Contract highlights

- `MeteoraDAMMv1Factory`
  - create pool factory
  - manage pool creation and fee config
- `DAMMv1Pool`
  - liquidity add/remove (WIP)
  - swap with invariant (WIP)
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
