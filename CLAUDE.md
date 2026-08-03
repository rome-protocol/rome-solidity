# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Public-safe file. No hostnames, keys, or backend topology. Internal deploy runbooks were removed in PR #289 (public-readiness cleanup). AI-contributor guidance is canonical in [`AGENTS.md`](AGENTS.md); the full contract map is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). This file summarizes what an agent needs before writing a line — read those two next.

## Overview

`rome-solidity` is the **Solidity SDK for Rome Protocol** — EVM chains running natively inside the Solana runtime. It ships:

- **Precompile ABIs** ([`contracts/interface.sol`](contracts/interface.sol)) — the ground floor. Bindings for CPI (`0xff…08`), Helper (`0xff…09`), System (`0xff…07`), Withdraw (`0x42…16`), and the cached family (`0xff…04/05/06/0b`).
- **CPI toolkit** ([`contracts/cpi/`](contracts/cpi/)) — builder-facing libraries to call any Solana program from Solidity. Start at [`contracts/cpi/README.md`](contracts/cpi/README.md).
- **SPL ↔ ERC-20 wrappers** ([`contracts/erc20spl/`](contracts/erc20spl/)) — `SPL_ERC20_cached` (default, journaled, revertable) + `SPL_ERC20` (CPI-track, needed only for raw-Solana-wallet egress). `ERC20SPLFactory` deploys the cached wrapper.
- **Bridge** ([`contracts/bridge/`](contracts/bridge/)) — `RomeBridgeWithdraw`: five egress rails over CCTP v2 + Wormhole (`burnUSDC`, `burnETH`, `burnToWormhole`, `transferNativeToWormhole`, `bridgeOutToSolana`). Off-chain orchestrator lives in `rome-bridge-api`.
- **Oracle** ([`contracts/oracle/`](contracts/oracle/)) — Pyth Pull + Switchboard V2 adapters behind the standard Chainlink `AggregatorV3Interface`; direct + cached variants; `OracleAdapterFactory` clones.
- **Primitives** — `rome_evm_account.sol` (unified `external_auth` PDA derivation), `activation/SimpleActivator.sol` (one-tx user-paid activation), `wrap/WrappedGasFacade.sol` (WETH9-shaped gas wrap/unwrap with canonical events), `spl_token/` + `system_program/` + `convert.sol` low-level libs.
- **Examples** ([`contracts/examples/`](contracts/examples/)) — worked references (`helper.sol`, `cached.sol`, `bench_*`, `pdas_batch.sol`, `bridge.sol`, `orra.sol`, `cu.sol`).

## Build & Test Commands

```bash
npm install                      # deps (Hardhat 3, viem, forge-std, OZ contracts 5)
npx hardhat compile              # Solidity 0.8.28, viaIR, optimizer runs=200
# Network-independent unit tests (CI runs these):
npx hardhat test nodejs tests/oracle/*.test.ts tests/bridge/*.test.ts tests/cpi/*.test.ts tests/token2022/*.test.ts
```

Integration tests under `tests/**/*.integration.ts` require a live Rome chain (`--network <name>` — see `hardhat.config.ts`). Configured networks: `martius` (121214), `subura` (121213), `trajan` (121302), `nerva` (210000), `hadrian` (200010). Each expects `<CHAIN>_PRIVATE_KEY` from Hardhat config-variables (keystore).

Source verification uses **Rome's own Sourcify instance** (`verify.testnet.romeprotocol.xyz`) — sourcify.dev doesn't know Rome chain ids. Etherscan/Blockscout are switched off in `hardhat.config.ts`.

CI (`.github/workflows/ci.yml`) runs on Node 22: compile → unit tests → **`tx.origin` ban** (grep-based, comment-tolerant, strict) → **CU-recon staleness** (every `CU_*` constant must carry `// recon YYYY-MM-DD` within 6 months) → **Slither** (non-blocking; detector exclusions in `.slither.config.json`, and a shim that merges Hardhat 3's split build-info into v2 layout for crytic-compile).

## Non-obvious architecture

### The two SPL wrapper tracks — one per contract, hard rule
Both `SPL_ERC20_cached` and `SPL_ERC20` expose the identical `IERC20 + IERC20Metadata` surface over the same SPL mint. A contract picks one and commits to it — mixing cached-track and legacy-track *mutating* calls in one tx is runtime-blocked by rome-evm's `verify_call` (`found_cpi` vs `found_cpi_cached` are sticky on the journal, per-tx). Cached is the default; only reach for CPI-track when you specifically need `bridgeOutToSolana` / `ensureRecipientAta` (raw-Solana-wallet egress via the permanently-CPI-only `create_ata_for_key`). Full explanation: [`docs/ARCHITECTURE.md` §3](docs/ARCHITECTURE.md#3-spl--erc-20-wrappers--contractserc20spl). Cross-chain background lives in the monorepo `rome-evm-private/CLAUDE.md` "Track selection — one track per contract" section.

### `CrossStateEthCall` is NOT a Solana CPI
The `0xff…08` precompile is dual-purpose. `invoke` / `invoke_signed` dispatch as real `Invoke` (`invoke_signed` syscall, sets `found_cpi`, iterative-VM-blocked on the legacy track). The read shortcuts (`account_info`, `account_data_at`, `account_u64_at`, `account_lamports`, `pdas_batch_derive`) dispatch as `CrossStateEthCall` — pure reads, no syscall, no `found_cpi`, unconditionally iterative-VM safe. Same story on the Helper (`0xff…09`) `pda` / `ata` / `user_balance` / `allowance_of` / `mint_info` selectors. "CPI shortcut" in old commit messages is a naming legacy — those selectors do not perform CPI. Getting this wrong is the single most common inference bug in agent sessions.

### Token nomenclature — canonical repo-wide
Native gas keeps the bare underlying symbol (`USDC` / `GAS` / `SOL`); ERC20-SPL wrappers get a lowercase `w` prefix (`wUSDC` / `wETH` / `wSOL`). Casing matches the on-chain `SPL_ERC20.symbol()` value the factory writes — display layer aligns with on-chain truth. Applies to every downstream consumer (rome-ui `wrapperSymbolFor()`, block explorer, etc.).

### The gas-wrapper facade
`wrap/WrappedGasFacade.sol` is WETH9-shaped `deposit()` / `withdraw()` over the cached-track gas-wrap precompile legs (`WithdrawCached 0xff..0b` + the cached wrapper's ERC-20 surface). Wraps native gas into the chain's gas-mint wrapper and unwraps back. Emits canonical `Deposit` / `Withdrawal` events so explorers / indexers see gas wrap/unwrap as ordinary WETH9 activity (the raw precompile legs carry no logs + no value). Cached-track only. Deploy runbook lives in the header NatSpec — constructor takes the gas-mint wrapper address; call idempotent `ensureAta()` once post-deploy.

### Bridge egress — five rails, one bytecode
`RomeBridgeWithdraw` takes an SPL-wrapper token in and fires a Solana CPI signed as the caller's Rome PDA. All rails are permissionless; network config injected via constructor so one bytecode works on every chain. CCTP is **v2** live (`ICCTPV2` / `CCTPV2Lib`); v1 encoder retained as `ICCTP` for reference but not imported. Wormhole native custody is derived per-mint at runtime (`find_program_address([mint], tokenBridge)`) — the v10 stored `wormholeCustody` serves one mint only, so `transferNativeToWormhole` derives per call. Custody signer is global.

### Token-2022 discipline
Wrappers read `mint_info` (same selector `0xe24bf5d4` on both Helper and cached-Spl dispatch homes) for delivered-amount reporting and to **refuse armed transfer hooks** — a mint with an armed hook can move less than the requested amount, and the wrapper must reject rather than mint against the requested figure. Fee-bps is a predicate (armed / not), not an operand — the real fee is capped by `maximum_fee` which `mint_info` deliberately does not carry. #301.

### `tx.origin` ban
No production Solidity file uses `tx.origin`. Cardo-foundation §9 forbids it (a router contract cannot sign a *user's* PDA — the precompile signs as `msg.sender`). Enforced by strict CI grep on `contracts/**/*.sol` (comment-tolerant). If you need "the user acting", it's an explicit `address` argument threaded through `UserPda.pda(address)` / `UserPda.ata(address, mint)`.

### CU recon comments
Every `CU_<OP>` numeric budget in `contracts/**/*.sol` must have `// recon YYYY-MM-DD` within 10 lines above or on the same line, and the date must be within 183 days. CI fails otherwise. Currently zero `CU_*` constants exist in this repo (they live in `rome-showcase` per the per-app-silo convention) — the job is a general-purpose guard for when they arrive.

## Key conventions

- **Read the registry, don't hardcode.** Chain ids, RPC URLs, contract addresses, token mints, Solana program ids all come from **[`rome-protocol/registry`](https://github.com/rome-protocol/registry)** or the `@rome-protocol/registry` NPM package. Deploy targets in `deployments/<network>.json` are point-in-time artifacts, not a source of truth for downstream consumers.
- **Solidity 0.8.28 + viaIR + `runs=200`** across `default` and `production` profiles. Don't bump to `runs=999999`; on Rome the aggressive inlining pushes iterative-VM legs past the ~1.4M-CU cap and 9× the Solana signatures per action (verified against the Uniswap V2 fork).
- **One CPI per Solana tx, atomic mode.** A CPI forces atomic mode; two CPIs won't fit one Solana tx's compute budget. That's why `burnETH` and `bridgeOutToSolana` are two-tx patterns (`approve` + `burn`, `ensureRecipientAta` + `bridgeOut`).
- **Every write on Rome uses `submitRomeTx` (EVM lane) or `submitRomeTxSolanaLane` (Solana lane).** Enforced in downstream apps via lint. Not applicable to unit tests here, but CI + integration tests must use the SDK path.
- **Deployments file is the deploy receipt, not the source of truth.** After every deploy, update the registry via the ops-side `publish-registry-pr` orchestrator.

## Cross-repo dep table

Contracts here are consumed across the Rome codebase. Keep this table honest — if a contract signature changes in a way that breaks a downstream call site, link the downstream PR in the description (and vice-versa).

| Downstream repo | rome-solidity surface it depends on |
|---|---|
| **rome-ui** | `RomeBridgeWithdraw.{burnUSDC, burnETH+approveBurnETH, bridgeOutToSolana, ensureRecipientAta}`; `SimpleActivator.activate() payable` + `activationCost()`; `ERC20SPLFactory.add_spl_token_no_metadata`; `SPL_ERC20.balanceOf` (reads AUTHORITY_PDA's ATA — the canonical bridged-token location) |
| **rome-uniswap-v2** | Canonical UV2 core (byte-identical to upstream). Composes natively with `SPL_ERC20_cached` (fully cache-track-clean reads + writes). Router-allowlist gate on `pair.mint` / `pair.burn` was removed in the pivot to canonical UV2 (rome-uniswap-v2 #59). |
| **rome-evm-private** | Every precompile ABI in `contracts/interface.sol` is the client-side counterpart of a dispatcher arm in `program/src/non_evm{,_cached}/`. Selector consts on both sides MUST equal `keccak256(canonical_signature)[..4]`; drift is the #1 source of silent dispatch failures. Any new precompile method requires: (a) selector + impl + dispatcher arm in rome-evm-private, (b) declaration here in `contracts/interface.sol` under the right interface (matching Solidity signature character-for-character), (c) a call site in `contracts/examples/`, (d) a row in `docs/ARCHITECTURE.md`. |
| **rome-sdk-ts** | Mirrors the full precompile ABI in TypeScript (`src/abis.ts`, `src/selectors.ts`, `src/addresses.ts`). SDK `submitRomeTx` + fee-sizing is the write path every rome-ui / cardo / appia call site uses. `RomeEVMAccount.pda` derivation is mirrored by `src/pda.ts`. |
| **compound-on-rome-comet** | **Vendors** the precompile bindings (`contracts/lib/RomePrecompiles.sol` — "copied from rome-solidity"). Reserves = cached wrappers wired by address. Oracle feeds through `IAggregatorV3Interface`. |
| **rome-aave-v3** | Reserves = cached wrappers (wUSDC / wETH / wSOL). AaveOracle reads adapters via `IAggregatorV3Interface`. |
| **cardo** / **appia** | Mirror the CPI precompile ABI in TS (`lib/cpi-precompile.ts`). Consume `SPL_ERC20_cached` for balance / transfer / allowance reads. |
| **rome-bridge-api** | Canonical off-chain consumer of `RomeBridgeWithdraw` — builds egress txns for all five rails, indexes `RomeBridgeEvents` for attribution. |

## Agent execution guide

- **Adding a precompile selector:** MUST land the four-way propagation (interface.sol declaration + rome-evm-private dispatcher arm + `contracts/examples/` call site + `docs/ARCHITECTURE.md` row) in one atomic set of paired PRs. Selector consts here must equal `keccak256(canonical_signature)[..4]`; verify with `cast keccak "<signature>"` before committing.
- **Cross-track migration** is a redeploy event, not a runtime decision. Deploy a new contract that binds to the other track; don't hybrid-modify.
- **After bridge / activator / factory / wrapper changes**, both integration and unit tests must be run — `tests/*.integration.ts` against a live chain, `tests/{oracle,bridge,cpi,token2022}/*.test.ts` in CI (nodejs runner).
- **Deployments file drift** — if a deploy target in `deployments/<network>.json` is stale, that's expected between deploys; the source of truth is the public registry PR that lands the deploy. Don't hand-edit deployment JSON to fix a UI symptom; find the drift.

## Reference

- [`AGENTS.md`](AGENTS.md) — the Rome-specific rules a coding agent needs (mental model, starting points, write path, CPI account rules, the SDK, the `rome` CLI + MCP server).
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — every contract, what it's for, and where it's used.
- [`README.md`](README.md) — public entry point.
- [`CHANGELOG.md`](CHANGELOG.md) — dated deploy / feature notes.
- [`contracts/cpi/README.md`](contracts/cpi/README.md) — the CPI Foundation guide.
- [`contracts/bridge/README.md`](contracts/bridge/README.md) — Phase-1-era; NatSpec on `RomeBridgeWithdraw.sol` + `docs/ARCHITECTURE.md` §4 supersede it for v2/native/`burnToWormhole` details.
