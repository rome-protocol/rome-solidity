# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`@rome-protocol/rome-solidity` — the **Solidity SDK for Rome Protocol**: precompile ABI bindings, the CPI toolkit, the SPL ↔ ERC-20 wrapper family, the on-chain bridge egress contracts, and the Chainlink-compatible oracle adapters. Consumed by every Rome app that touches Solana from Solidity (`rome-showcase` / `cardo` / `appia` / `aerarium` / `compound-on-rome-comet` / `rome-aave-v3` / `rome-dex` / `rome-bridge-api` / …).

**Read AGENTS.md before writing code.** [`AGENTS.md`](AGENTS.md) is the canonical set of Rome-specific rules a coding agent needs (three mental-model facts, the six rules that bite on every path, the `rome` CLI + MCP server, the SDK write-path invariants). This CLAUDE.md is the **repo-scoped** operator manual layered on top — build/test commands, the contract map, gotchas that live here specifically.

**Read `docs/ARCHITECTURE.md` and `contracts/README.md`.** ARCHITECTURE.md is the full contract map (7 layers, why each exists, where each is used across the Rome ecosystem). `contracts/README.md` is the **discovery map** — it encodes the admission rule ("type from code, address from data") and lists which contracts live in which area with a hard split between precompiles (fixed constants) and application contracts (per-chain, registry-sourced).

## Build & Test Commands

Node 22 in CI; Hardhat 3 (`hardhat.config.ts`, ESM, viem 2, no ethers).

```bash
npm install
npx hardhat compile

# Network-independent tests (unit + libraries; no live chain).
# These are what CI runs after `hardhat compile`:
npx hardhat test nodejs \
  tests/oracle/*.test.ts \
  tests/bridge/*.test.ts \
  tests/cpi/AccountMetaBuilder.test.ts \
  tests/cpi/AnchorInstruction.test.ts \
  tests/cpi/Cpi.test.ts \
  tests/cpi/CostEstimator.test.ts \
  tests/cpi/CpiAdapterBase.test.ts \
  tests/cpi/CpiError.test.ts \
  tests/cpi/PdaDeriver.test.ts \
  tests/cpi/SolanaConstants.test.ts \
  tests/cpi/UserPda.test.ts \
  tests/token2022/*.test.ts \
  tests/erc20spl/*.test.ts \
  tests/activation/*.test.ts

# ABI parity gate — required after compile. Fails the build if a
# discovery interface drifts from its implementation (either direction).
node scripts/check-abi-parity.js

# Integration tests (`tests/**/*.integration.ts`) require a LIVE Rome chain
# (`--network local` for a rome-setup local stack, or a devnet/testnet
# chain configured in hardhat.config.ts). Not run in CI. Same for
# `tests/erc20spl_factory_hijack.poc.ts` (mint-authority front-run regression,
# #326 — needs a live chain, run when touching factory init flow).
```

**Per-network deploys.** `hardhat.config.ts` configures: `martius` (121214), `subura` (121213), `trajan` (121302), `nerva` (210000), `hadrian` (200010, canonical devnet benchmark), `rubicon` (7531, mainnet — URL held in `RUBICON_RPC_URL`), `sepolia`, `local` (`http://localhost:9090`). Each network reads its private key via `configVariable("<NAME>_PRIVATE_KEY")` — set via the Hardhat 3 keystore (`npx hardhat keystore set <NAME>_PRIVATE_KEY` for production, `--dev` for local).

**Rubicon (mainnet) gotcha.** The Rome proxy enforces a pool-derived minimum gas price but serves stub `eth_feeHistory` values, so Hardhat's automatic fee estimation underprices every tx (rejected with "Gas_price is less than the minimum value"). Pin a legacy `gasPrice` before running: `export RUBICON_GAS_PRICE=$(( $(cast gas-price -r <rpc>) * 11 / 10 ))`.

**Cold-Ledger deploys.** `scripts/deploy-ledger.ts` signs every deploy tx with a Ledger (Ethereum app, Blind signing ON) via `DEPLOY_VIA_LEDGER=1 ROME_RPC_URL=… ROME_CHAIN_ID=… npx tsx scripts/deploy-ledger.ts`. Used for factory + wrapper + adapter deploys where a hot key is not acceptable.

**Source verification.** `hardhat.config.ts` sets `verify.sourcify.apiUrl` to Rome's own Sourcify instance (`https://verify.testnet.romeprotocol.xyz`) since sourcify.dev doesn't know Rome chain ids. Etherscan + Blockscout are disabled (`enabled: false`) because no Rome chain is listed on either.

Solidity `0.8.28`, `viaIR: true`, `runs: 200`. Two profiles (`default` + `production`) currently mirror the same settings.

## CI

`.github/workflows/ci.yml` — four jobs on ubuntu-latest, all Node 22:

1. **`build-and-test`** (required, 15min timeout): `npm install` → `hardhat compile` → **`scripts/check-abi-parity.js`** → the unit + library test set above (oracle + bridge + cpi + token2022 **+ erc20spl + activation** — every `.test.ts` under those trees). Concurrency-scoped to `github.ref` — a new push cancels prior queued/running runs on the same branch (the "stuck-queued" failure mode from 2026-05-15). The `.integration.ts` files under those same trees are deliberately not matched (they need a funded live chain); run them manually per the Test Selection Guide.
2. **`tx-origin-ban`** (strict, 5min): `grep -rnE 'tx\.origin' --include='*.sol' contracts/` — fails if any non-comment line in `contracts/**/*.sol` references `tx.origin`. Comments referencing it for documentation stay allowed. Uses `grep` (not `git grep`) because BRE/ERE don't honor `\b`. Enforced per `cardo-foundation §9` — the `UserPda` toolkit is the fix.
3. **`cu-recon-staleness`** (strict, 5min): every `CU_<OP>` constant must carry an adjacent `// recon YYYY-MM-DD` comment within 10 lines above, no older than 6 months. `rome-solidity` doesn't ship adapter CU tables today, so this passes green — the job is mirrored from `rome-showcase` so any future CU constant here is caught without a config change.
4. **`slither`** (informational, `continue-on-error: true`, 20min): Slither static analysis, gated by `.slither.config.json` (`reentrancy-eth,reentrancy-events,incorrect-shift` excluded — the first two because Solana CPI precompiles are synchronous with the Solana runtime + `CpiAdapterBase` uses `ReentrancyGuard`; the third is a `convert.sol` endian-helper false positive). Ships a Hardhat-v3-to-v2 build-info merge shim (crytic-compile's hardhat handler still expects the v2 combined JSON — see crytic-compile#629).

**Dependabot auto-merge** (`.github/workflows/dependabot-auto-merge.yml`) — Phase 2: patch + minor updates for `github_actions`, `cargo`, `npm_and_yarn`, `pip`, `gomod` auto-merge; major bumps and Docker stay manual. The npm branch runs `npm ci` first as a lockfile-sync guard (Dependabot has occasionally dropped still-required nested lockfile entries).

## Architecture (fast read)

Full map in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the layers, high to low:

```
examples/                        worked references
  ├── erc20spl/  bridge/  oracle/   capabilities you consume
  │        └── cpi/                    builder-facing CPI toolkit
  │              └── interface.sol       precompile ABIs (the ground floor)
  └── spl_token/ system_program/ rome_evm_account  low-level account/token primitives
```

**Precompile interfaces — `contracts/interface.sol`.** THE chain-ABI header. Two families: the CPI/utility family (`ISystemProgram` `0xff…07`, `ICrossProgramInvocation` `0xff…08`, `IHelperProgram` `0xff…09`, `IWithdraw` `0x42…16`) and the **cached** family (`ISystemCached` `0xff…04`, `ISplCached` `0xff…05`, `IAssociatedSplCached` `0xff…06`, `IWithdrawCached` `0xff…0b`) whose side effects route through the rome-evm journal so they revert atomically with EVM state and are iterative-VM compatible. **Precompile addresses are constants of the rome-evm program dispatch** — this is the ONE file allowed to hardcode addresses.

**Admission rule (hard).** An interface belongs in `interface.sol` **iff its address is a fixed constant burned into the rome-evm dispatch**. Everything else is an application contract, lives in its area's own file, and its address comes from `rome-protocol/registry`, never from a `.sol` file. The rule was made explicit in #320 (2026-08); `IRomeBridgeWithdraw` moved to `contracts/bridge/interfaces/` in the same PR. `contracts/README.md` is the discovery map that encodes it.

**ABI parity gate (`scripts/check-abi-parity.js`, #321).** Solidity's `is IFoo` only enforces one direction (interface ⊆ impl). This script enforces the other direction too (every externally callable state-mutating function in the impl must appear in the interface). Runs after `hardhat compile` in CI. Add a `{ iface, impl }` pair to `PAIRS` when a new discovery interface lands. This gate exists because `IRomeBridgeWithdraw` shipped without `burnToWormhole`, `transferNativeToWormhole`, and `bridgeOutToSolana`.

**SPL ↔ ERC-20 wrappers — `contracts/erc20spl/`.** Three wrapper kinds (`ERC20SPLFactory.WrapperKind`):
- **`SPL_ERC20_cached`** (the default) — cached-track wrapper; mutations dispatch through `SplCached`/`AssociatedSplCached`, journaled so they revert atomically with the EVM tx and work in iterative-VM composition. Deployed by `ERC20SPLFactory` for every new token.
- **`SPL_ERC20`** (legacy CPI-track) — mutations dispatch through `HelperProgram` → real CPI Invoke; hits Solana at call time (not revertable if the EVM tx later reverts), incompatible with iterative-VM composition after the first CPI. Retained only for its Solana-wallet exit path (`bridgeOutToSolana` / `ensureRecipientAta`, which need the permanently-CPI-only `create_ata_for_key`).
- **`SPL_ERC20_Token2022Hooked`** (#301, #307, #309) — direct-CPI ERC-20 surface for a **Token-2022 mint with an armed Transfer Hook**. Callers pass the resolved hook-account tail; the wrapper validates the hook-program + validation-PDA trailer, then forwards it unchanged to Token-2022. Constructor reads `HelperProgram.mint_info(mint)` and refuses non-Token-2022 mints or mints without an armed hook. Deployed via `ERC20SPLHookedDeployer` (keeps the creation code out of `ERC20SPLFactory`'s runtime bytecode).

**A contract uses ONE wrapper track, never both** — hard rule enforced by rome-evm's `verify_call` at runtime.

**Wrappers sign as themselves (#338, 2026-08).** All three wrapper implementations moved off borrowed-owner authority for the same reason as the bridge (`verify_call` refuses mutating-precompile DELEGATECALL). Each wrapper now uses an **immutable escrow ATA** owned by its own PDA and tracks holder balances against an EVM-side ledger the precompile legs don't touch (`escrow-ata-immutable.test.ts`, `escrow-ledger.test.ts`, `direct-call-escrow-shape.test.ts` pin the shape). `ensureRecipientAta` remains the only exempt selector — bridge-out flows unchanged for the ATA-create leg.

**Factory mint-authority front-running fix (#326, #327, 2026-08).** `ERC20SPLFactory.create_token_mint()` is now atomic — mint account creation + `InitializeMint2` in a single call (`HelperProgram.create_and_init_mint`) — closing the two-call window in which a third party could front-run `init_token_mint` on someone else's freshly-created mint and steal issuance. `init_token_mint(bytes32)` is now an inert `view` (asserts `is_initialized` and reverts otherwise, no state change) — existing two-step callers keep working, the second call is a successful no-op. Derived mint address unchanged. Regression: `tests/erc20spl_factory_hijack.poc.ts` (live-chain). Rubicon redeployed at the fix (#327).

**Bridge — `contracts/bridge/`.** `RomeBridgeWithdraw` — the single outbound entrypoint, five egress rails (CCTP v2 USDC, Wormhole ETH, generic Wormhole `transfer_wrapped`, Wormhole `transfer_native` for Solana-native mints, and direct Rome→Solana SPL). `RomeBridgeEvents` is the canonical event schema for indexers (`rome-bridge-api` is the off-chain orchestrator). `ICCTPV2`/`CCTPV2Lib` is the live encoder; `ICCTP`/`CCTPLib` (v1) is retained-reference only. `IWormholeTokenBridge` covers `transfer_wrapped` (tag 4) and `transfer_native` (tag 5).

**Bridge signs as ITSELF, not the caller (#338 / #339, 2026-08 — ABI-breaking).** rome-evm now refuses DELEGATECALL/CALLCODE into mutating non-EVM precompile selectors unless explicitly exempt, so the bridge can no longer have the program sign a Solana instruction under the caller's identity. Every mutating egress leg (`_burnUSDC`, `burnETH`, `burnToWormhole`, `transferNativeToWormhole`, `bridgeOutToSolana`) now dispatches via **direct CALL** and signs as the bridge's own PDA. Consequences:
- **`approveBurnETH` + `approveWormholeBurn` are DELETED** — a contract can no longer set an SPL delegate on a user's ATA. Callers instead grant the bridge an SPL delegate on their own ATA once, off-contract, by sending `approve_spl(bridge, amount, mint)` (or `approve_spl_raw_delegate` for the raw variant) directly to `HelperProgram` at `0xff..09`. Every outbound rail's docstring in `IRomeBridgeWithdraw` names this prior grant.
- **CCTP + Wormhole burns pull first, burn second.** The four burns move the caller's SPL into the **bridge's own ATA** (via `transfer_spl` as the caller's delegate), then burn from there as the true owner. Wormhole's `authority_signer` delegation is re-granted on that shared ATA each call.
- **New `ensureBridgeAta(bytes32 mint)` — owner-only, per-mint, one-shot.** The pull leg has no create fallback, so every mint the bridge egresses needs this run once at deploy time. `ensureRecipientAta` (untouched) is still the user-side pre-`bridgeOutToSolana` step.
- **Operational impact: the bridge's own PDA is now the CCTP `messageSentEventData` / Wormhole message rent payer** on every burn (previously each user's PDA). It must hold a funded SOL float, monitored, with an automated top-up (fee-revenue recoup is the ratified funding model).
- The `WormholeMintAllowed` allowlist stays mint-keyed (v10, #272); `wormholeAssetAllowed` remains a view (mint-derived) for caller compatibility.

**Oracle — `contracts/oracle/`.** Solana price feeds (Pyth Pull, Switchboard V2) surfaced through the standard Chainlink `AggregatorV3Interface`. Direct adapters (`PythPullAdapter`, `SwitchboardV3Adapter`) read on every call; cached adapters (`CachedPythAdapter`, `CachedFeedAdapter`) do the parse + SSTORE on a keeper `refresh()` tx so `latestRoundData()` is a cheap SLOAD. **`PriceBook`** (#318, 2026-08) is one aggregated write for N feeds — permissionless `refreshAll` with per-feed branch isolation (commit/skip/fault; reverts only when every attempted feed faulted), plus `BookFeedAdapter` view facades that keep the Chainlink read shape unchanged. `PriceBook` + `BookFeedAdapter` **pause fail-closed** (#322): pause flips a served entry's status to `paused` so reads revert immediately (rather than aging out); unpause resumes only with a strictly-newer AND fresh validated update, else stays paused via atomic rollback. `OracleAdapterFactory` deploys all four adapter kinds as EIP-1167 clones and validates the Solana account's owner-program on registration. `BatchReader` fans out reads with per-feed `try/catch` isolation.

**Account & token primitives.** `rome_evm_account.sol` derives the unified `external_auth` PDA (+ salted variants). `activation/SimpleActivator.sol` — one-tx user-paid bootstrap (`activate{value}()`) that funds the PDA + creates wUSDC/wSOL ATAs + registers the user (~234K CU). `wrap/WrappedGasFacade.sol` — WETH9-shaped `deposit()`/`withdraw()` over the native-gas-wrapper precompiles so explorers see canonical `Deposit`/`Withdrawal` events (cached track only). Since #339 (2026-08) the facade also runs on the direct-CALL / signs-as-itself model: it stops calling the wrapper's ERC-20 surface and moves the underlying SPL straight to/from each caller's own ATA via `SplCached.transfer` / `SplCached.transferFrom` (cached end-to-end — the pre-review `HelperProgram.transfer_spl` unwrap leg mixed tracks in one tx and was rejected by the one-track rule). Consequences: `withdraw()`'s precondition is now an SPL-level `approve_spl(facade, tokens, mint)` grant to `0xff..09`, **not** an ERC-20 `wrapper.approve`; the constructor pins the wrapper to the chain's gas mint (`SystemProgram.mint_id()`) so `weiPerToken` can't desync from the precompile's own divisor; a one-shot idempotent `ensureAta()` bootstrap must run post-deploy before the first wrap. Contract-composed callers (no ATA of their own) are out of scope for this route. `spl_token/`, `system_program/`, `convert.sol` are the pure Borsh/LE encoders + decoders the wrappers rest on.

**CPI toolkit — `contracts/cpi/`** ("Cardo CPI Foundation"). See `contracts/cpi/README.md` for the three-layer adapter pattern (`Interface` + `Adapter` + `CpiBackend`), the `tx.origin` ban rationale, and the copy-paste skeleton. Core surface: `Cpi` (canonical `invoke`/`invokeSigned` wrapper), `AccountMetaBuilder`, `AnchorInstruction`, `AccountReader` (pure-read shortcut selectors — no signing), `PdaDeriver` + `PdasBatch`, `UserPda` (always takes an explicit `address`, never `tx.origin`), `EnsureAta`, `SolanaConstants`, `CostEstimate`/`CostEstimator`/`ICostView`, `CpiError`, and the `templates/CpiAdapterBase` (Ownable + Pausable + ReentrancyGuard + rotatable backend).

## Deployments

`deployments/<network>.json` is a **local receipt** written by the deploy scripts, one file per configured network (`hadrian.json`, `martius.json`, `nerva.json`, `rubicon.json`, `subura.json`, `trajan.json`). Live contract addresses for downstream consumers are canonical at **[`rome-protocol/registry`](https://github.com/rome-protocol/registry)** — never hardcode a Rome-side contract address in this repo. When a deploy lands, mirror it into `chains/<id-slug>/contracts.json` (+ `oracle.json` / `bridge.json` where applicable) in the registry.

## Precompile Interfaces — Quick Reference

Full canonical surface (every selector, dispatch variant, source `file:line`) lives in `rome-evm-private/CLAUDE.md`. What lives on the Solidity side here:

- `0xff…04` **`SystemCached`** — journaled System-program ops (`create_pda` / `allocate` / `transfer`)
- `0xff…05` **`SplCached`** — journaled SPL Token ops (ERC-20-shaped transfer/approve/mint + cross-state reads)
- `0xff…06` **`AssociatedSplCached`** — journaled ATA creation
- `0xff…07` **`SystemProgram`** — PDA derivation, base58 codec, chain-identity getters (pure/view)
- `0xff…08` **`CrossProgramInvocation`** — raw CPI primitive: `invoke` + `invoke_signed` + read shortcuts (`account_info`, `account_data_at`, `account_u64_at`, `account_lamports`, `pdas_batch_derive` — these are **NOT CPIs**, they're `CrossStateEthCall` reads, no syscall, no signing)
- `0xff…09` **`HelperProgram`** — composite one-shots: `pda(address)`, `ata(address[, mint])`, `create_pda`, `create_ata`, `create_ata_for_key` (CPI-only, permanently), `transfer_spl` variants, `approve_spl`, `mint_spl`, `mint_info(bytes32)`, `swap_gas_to_lamports`, `deposit_from_ata` (unwrap)
- `0xff…0b` **`WithdrawCached`** — journaled gas exit + `deposit` inverse (SPL → native gas)
- `0x42…16` **`Withdraw`** — legacy non-revertable native-gas exit

The read-shortcut disambiguation matters when reasoning about iterative-VM composition or when a tx "should" have a CPI syscall in logs and doesn't. See `rome-evm-private/CLAUDE.md` § "Read this first — `CrossStateEthCall` is NOT a Solana CPI".

## Conventions & Gotchas

- **`.sol` never hardcodes an app-contract address** — only precompile constants in `interface.sol` may. Every other address comes from `rome-protocol/registry` at runtime (TS side) or as a constructor arg (Solidity side).
- **`tx.origin` is banned in `contracts/`** — CI job `tx-origin-ban` enforces this. Use `UserPda.pda(msg.sender)` or the explicit `address user` argument in the three-layer adapter pattern.
- **Cached track is the default; a contract uses one track, never both.** Reach for the CPI-track `SPL_ERC20` only when you specifically need `bridgeOutToSolana` / `ensureRecipientAta`.
- **Wrapper warm-transfer path is one precompile write (2026-09).** No `ERC20Users.ensure_user` on transfer/create/bridge-out (nothing reads `get_user`; the registry stays for `SimpleActivator` and ABI compatibility), `mint_info` only on a `fee_capable` mint (TransferFeeConfig is fixed at InitializeMint → constructor immutable), recipient-ATA flag checked BEFORE any derivation/probe (and a successful probe sets it), hooked wrapper's own PDA is the `self_pda` immutable. Guarded by trap tests `tests/erc20spl/hot-path.test.ts`, `cached-hot-path.test.ts`, `tests/token2022/hooked-hot-path.test.ts` — a change that re-adds a per-transfer read fails them.
- **`RomeBridgeWithdraw` events live in `RomeBridgeEvents`**, not on the interface. Indexers subscribe to `RomeBridgeEvents`.
- **Outbound bridge + `WrappedGasFacade.withdraw` need a caller-side SPL delegate grant.** Since #338/#339, no contract can approve on the caller's behalf: `approveBurnETH`/`approveWormholeBurn` are gone, and the facade no longer takes ERC-20 `approve`. The caller sends `approve_spl(<bridge or facade>, amount, mint)` (or `approve_spl_raw_delegate` for Wormhole ETH) directly to `HelperProgram` at `0xff..09` before the outbound call. Bridge PDA / facade must have their own ATA already (`ensureBridgeAta` / `ensureAta` one-shot).
- **Every write from TypeScript goes through the SDK.** On the EVM lane use `submitRomeTx`; on the Solana lane use `submitRomeTxSolanaLane`. Never raw `wagmi`/`ethers`/`viem` `writeContract` — Rome writes have specific fee + submission semantics. This is a repeated finding — see AGENTS.md rule 1.
- **`eth_estimateGas` over-predicts on Rome.** The proxy charges the exact gas used, so don't size hard budgets off the estimate. A plain native-token transfer costs ~1.48M gas (not 21k) because it materializes the recipient's Balance PDA.
- **CCTP v2 is live** (`ICCTPV2`/`CCTPV2Lib`). `ICCTP` v1 stays as reference; not imported by `RomeBridgeWithdraw`.
- **Wormhole `transfer_native` uses per-mint custody**, derived at runtime as `find_program_address([mint], tokenBridge)` — matches `deriveCustodyKey` from `@wormhole-foundation/sdk-solana-tokenbridge`. Don't confuse with `transfer_wrapped`'s custody model.
- **Solidity 0.8.28, `viaIR: true`**. If a change hits a stack-too-deep or verification issue, check the viaIR path before disabling it.
- **Adding a new `CU_<OP>` constant?** Add a `// recon YYYY-MM-DD` comment within 10 lines above it or CI fails. Refresh (measure + update) every ≤6 months.

## Change Impact Map

| If you change... | Also check/update... |
|-----------------|---------------------|
| `contracts/interface.sol` precompile signatures | `rome-evm-private/program/src/non_evm/*` dispatch (the source of truth); `rome-sdk-ts/src/{abis,selectors,addresses}.ts`; `compound-on-rome-comet/contracts/lib/RomePrecompiles.sol` (vendored); every app repo mirroring the ABI in TS (cardo, appia, `lib/cpi-precompile.ts`) |
| A discovery interface (`IRomeBridgeWithdraw`, future additions) | Run `node scripts/check-abi-parity.js` after `hardhat compile`. Add the `{ iface, impl }` pair to `PAIRS` in `scripts/check-abi-parity.js` if introducing a new one. |
| `RomeBridgeWithdraw` (any rail) | `rome-bridge-api` (orchestrator), `rome-ui`/`appia`/`cardo` outbound flows, `deployments/<network>.json`, `rome-protocol/registry` chain `contracts.json` / `bridge.json`. Any client that previously called `approveBurnETH` / `approveWormholeBurn` must now emit a caller-EOA `approve_spl` to `0xff..09` instead (deleted in #339). Every newly-bridged mint needs one owner-only `ensureBridgeAta(mint)` at deploy time. |
| SPL_ERC20 wrapper family | `ERC20SPLFactory.WrapperKind` enum + factory dispatch; `rome-showcase`, `rome-uniswap-v2/v3`, `compound-on-rome-comet`, `rome-aave-v3` (all trade against the cached wrappers). Direct-call escrow shape is pinned by `escrow-*` + `direct-call-escrow-shape` tests — a re-add of the borrowed-owner-authority pattern fails them. |
| `ERC20SPLFactory` mint-flow (`create_token_mint` / `init_token_mint`) | Redeploy the factory + migrate every consumer (registry `contracts.json`, `ERC20Factory`/wrapper factory addresses in downstream repos) + orphaned-mint sweep of the pre-fix window (rubicon precedent, #327). |
| `WrappedGasFacade` | Its withdraw path now requires the caller to have sent `approve_spl(facade, tokens, mint)` to `0xff..09` — any UI/SDK doing `wrapper.approve(facade, …)` for this needs re-plumbing. Constructor is pinned to the chain's gas mint; deploy on a different chain's gas mint reverts `MintMismatch`. |
| Oracle adapters or `PriceBook` | `rome-oracle-gateway` (pointer repo + portal), `rome-oracle-portal` keeper (`refresh()` cadence + `maxStaleness`), `registry/chains/<id>/oracle.json`, downstream consumers (`rome-aave-v3` AaveOracle, `compound-on-rome-comet` price feeds) |
| CPI toolkit (`contracts/cpi/`) | Every Cardo adapter in `rome-showcase/contracts/<adapter>/`, `contracts/cpi/README.md` |
| `hardhat.config.ts` networks / verify config | `hardhat.config.ts` keystore variable names must match `<CHAIN>_PRIVATE_KEY` pattern; Rome Sourcify URL is the only enabled verifier (etherscan/blockscout intentionally off) |
| CI (`ci.yml`) | If bumping Node, keep it in step with local dev + AGENTS.md; if changing test list, mirror in this file's Build section |

## Test Selection Guide

| What Changed | Tests to Run |
|-------------|-------------|
| `interface.sol` or a precompile ABI | Full unit set + `node scripts/check-abi-parity.js` + `tests/token2022/mint-info.selectors.test.ts` + `tests/erc20spl/cached.selectors.test.ts` |
| Bridge (`RomeBridgeWithdraw`, CCTP/Wormhole libs) | `tests/bridge/*.test.ts` (incl. `RomeBridgeWithdraw.direct-call.test.ts` — the direct-CALL / signs-as-itself shape guard from #339) + parity gate + `tests/bridge/RomeBridgeWithdraw.integration.ts` against a funded devnet chain |
| Oracle (adapters, `PriceBook`, `BookFeedAdapter`) | `tests/oracle/*.test.ts` (unit) — the full suite exercises the pause fail-closed + rollback invariants |
| CPI toolkit | `tests/cpi/*.test.ts` |
| SPL_ERC20 wrappers (any track) | `tests/erc20spl/*.test.ts` — `hot-path.test.ts` / `cached-hot-path.test.ts` (one-precompile-write warm transfer trap, #345), `direct-call-escrow-shape.test.ts` / `cached-direct-call-escrow-shape.test.ts` / `escrow-ata-immutable.test.ts` / `escrow-ledger.test.ts` (direct-call / signs-as-itself shape, #338), `ensure-token-account-created-flag.test.ts` / `cached-ensure-token-account-created-flag.test.ts` (flag-first ATA), plus `evm-allowance.test.ts` / `approve-saturation.test.ts` / `bridge-out-collapse.test.ts` / `view-defensive.test.ts` / `cached-transfer-behaviour.test.ts` / `escrow-ata-abi-scope.test.ts`. Live-chain: `tests/erc20spl/cached.integration.ts` |
| Token-2022 hooked wrapper | `tests/token2022/*.test.ts` (incl. `direct-call-hooked-shape.test.ts` / `hooked-transfer-behaviour.test.ts` / `hooked-hot-path.test.ts` — post-#338/#345 shape + warm-path guards) + `scripts/token2022/smoke-hooked-wrapper-hadrian.ts` against Hadrian |
| Simple activator | `tests/activation/simple-activator.test.ts` + `scripts/activation/deploy-simple-activator.ts` on a devnet chain |
| WrappedGasFacade | `tests/wrap/WrappedGasFacade.direct-call.test.ts` (unit; #339 direct-call shape) + `tests/wrapped_gas_facade.integration.ts` (integration only; requires funded chain) |
| ERC20SPLFactory (mint-authority front-running fix, #326) | `tests/erc20spl_factory_hijack.poc.ts` on a live chain — reproduces the pre-fix precondition against the old factory and asserts the atomic `create_token_mint` + view-only `init_token_mint` on the new one |
| Ensure-ATA / factory / cached wrapper on-chain paths | `tests/{ensure_ata,erc20spl_factory,erc20spl/cached}.integration.ts` |
