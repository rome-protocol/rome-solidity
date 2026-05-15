# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## Unreleased

### Changed — Meteora `_derive_permissionless_pool_with_config_keys` migrated to PdasBatch
First production consumer of the new `PdasBatch` library. The Meteora permissionless-pool init helper in `meteora/damm_v1_pool.sol` previously called `find_program_address` 12 times in a row (4 distinct dynamic_vault_program PDAs, 5 dynamic_amm_program PDAs, 1 pool, 2 LP-mint, 1 metadata). After this PR the 9 fully-batchable derivations collapse into **3 PdasBatch calls** — saving 6 syscalls per pool init:

| Batch | Program | PDAs |
|---|---|---|
| A | `dynamic_vault_program` | `a_vault`, `b_vault` (2-PDA `PdasBatch.pair`) |
| B | `dynamic_vault_program` | `a_token_vault`, `b_token_vault` (2-PDA `PdasBatch.pair`; depends on Batch A) |
| C | `dynamic_amm_program`   | `lp_mint`, `a_vault_lp`, `b_vault_lp`, `protocol_token_a_fee`, `protocol_token_b_fee` (5-PDA `PdasBatch.derive`) |

Preserved as individual derivations (can't batch — different programs / conditional):
- `pool` (single dynamic_amm_program derivation, no peer derivations to batch with)
- `a_vault_lp_mint` / `b_vault_lp_mint` (conditional Devnet-override short-circuit in `derive_lp_mint_key`)
- `mint_metadata` (Metaplex Token Metadata — different program)

Side effects:
- `_derive_permissionless_pool_with_config_keys` mutability flipped `pure → view` because `PdasBatch.derive` calls `CpiProgram.pdas_batch_derive` which is `view`-declared upstream.
- `derive_initialize_permissionless_constant_product_pool_with_config_accounts` (single library caller) cascaded `pure → view`. Factory caller (`damm_v1_factory.sol:120`) is already `view`, so no further cascade.

No ABI change. Output is byte-identical to the prior derivation chain (output ordering contract from PdasBatch's NatSpec: `result[i]` ↔ `seedGroups[i]`).

CU measurement post-deploy will land in `rome-specs/active/technical/2026-05-14-rome-primitive-cu-baseline.md` — paired follow-up, not gating this ship per the surface rollout plan.

### Added — `PdasBatch` library — surfaces `pdas_batch_derive` for everybody
New library `contracts/cpi/PdasBatch.sol` wraps the `pdas_batch_derive` CPI shortcut selector (`0x944336f8` on `0xFF…08`) — N independent PDAs against one Solana program in one syscall. Counterpart to the existing `PdaDeriver` (single PDA via `0xFF…07`); both stay available, callers pick by shape.

Primary surface:
- `PdasBatch.derive(ISystemProgram.Seed[][] groups, bytes32 programId) → ICrossProgramInvocation.PdaWithBump[]` — arbitrary N (≤ 16)
- `PdasBatch.pair(seedsA, seedsB, programId)` — common 2-PDA shape
- `PdasBatch.triplet(seedsA, seedsB, seedsC, programId)` — 3-PDA
- `PdasBatch.quad(seedsA, seedsB, seedsC, seedsD, programId)` — 4-PDA

Hard limits enforced by the precompile (per `rome-evm-private/program/src/non_evm/derive_helpers.rs`): N ≤ 16, M ≤ 8 inner seeds, len ≤ 32 bytes per seed. Output ordering is deterministic — `result[i]` corresponds to `seedGroups[i]`, a stability contract every downstream consumer (rome-sdk TS + Rust mirrors, off-chain previews) depends on.

No new types: input element is `ISystemProgram.Seed` (reused — compatible with existing `PdaDeriver.seedBytes` / `makeSeeds` builders), result element is `ICrossProgramInvocation.PdaWithBump` (already declared in `interface.sol`). The library lives next to the precompile that owns the call, not under `SystemProgram`.

Files added:
- `contracts/cpi/PdasBatch.sol` — the library
- `contracts/cpi/test/PdasBatchWrapper.sol` — Hardhat test wrapper
- `contracts/examples/pdas_batch.sol` — worked example (5-PDA Meteora-shape + 2-PDA Cardo-shape)
- `tests/cpi/PdasBatch.test.ts` — network-independent shape assertions

Live-precompile path is exercised end-to-end via the paired Meteora migration PR.

### Changed — `SimpleActivator` split into THREE calls (was two)
End-to-end testing on Marcus surfaced that the two-call shape (`activate()` + `createTokenAccounts()`) emulated at ~1.65M CU on the canonical deploy — over Solana's 1.4M-CU per-tx cap — because `create_payer(activator, 5M)` doesn't fast-path at the rome-evm-private level even when the activator's PDA balance already exceeds the target. Bundling two ATA-create CPIs in one tx pushes total CU over the cap regardless of priming.

The fix: split `createTokenAccounts()` into `createWusdcAta()` + `createWsolAta()`. Each call is ~950K CU (one ATA + one create_payer), comfortably under the cap. UI fires three txs sequentially behind one button click. Per-call cost dropped to 0.5 USDC (down from 1 USDC for the bundled call) so total user cost stays at 2 USDC.

ABI changes:
- **Removed** `createTokenAccounts() payable` + `TokenAccountsCreated(address,uint256)` event
- **Added** `createWusdcAta() payable` + `WusdcAtaCreated(address,uint256)` event
- **Added** `createWsolAta() payable` + `WsolAtaCreated(address,uint256)` event
- `tokenAccountsCost()` view unchanged in signature; meaning is now per-call

### Added — `SimpleActivator` (initial three-tx PDA + ATA bootstrap)
First-time bootstrap entry point on Rome chains. Three `payable` functions because each ATA-create + activator-PDA-topup CPI pair consumes ~950k CU on Solana, and bundling two ATA creates in one tx (~1.65M CU emulated) exceeds Solana's 1.4M-CU per-tx cap:

- **`SimpleActivator.activate()`** — funds the user's unified PDA at the rent-exempt floor (890,880 lamports) via `RomeEVMAccount.create_payer` + registers the EVM address in the `ERC20Users` mapping via `users.ensure_user`. Caller sends `msg.value ≥ activationCost()` (default 1 USDC). Idempotent: refunds `msg.value` if the user PDA already has lamports.
- **`SimpleActivator.createWusdcAta()`** — tops up the activator's own PDA via `create_payer`, then creates the user's WUSDC ATA via the wrapper's `ensure_token_account` (owned by the user's PDA). Caller sends `msg.value ≥ tokenAccountsCost()` (default 0.5 USDC). Idempotent.
- **`SimpleActivator.createWsolAta()`** — same pattern for WSOL ATA.

Total user cost: ~2 USDC across three MetaMask confirmations. The rome-ui fires the three txs sequentially behind a single button click. After this, downstream wrapper writes (`transfer` / `approve` / `transferFrom`), DEX swaps, and bridge-out flows resolve `users.get_user(msg.sender)` correctly and the user's WUSDC + WSOL ATAs exist on Solana — rent-exempt for life.

Sybil resistance: user pays all calls themselves; zero operator subsidy. Uses only existing precompiles and existing primitives (`RomeEVMAccount.create_payer`, `ERC20Users.ensure_user`, `SPL_ERC20.ensure_token_account`) — no new precompile, no rome-evm-private change.

- **`contracts/activation/SimpleActivator.sol`** — entry point. Constructor: `(activationCost, tokenAccountsCost, usdcWrapper, wsolWrapper, users)`.
- **`scripts/activation/deploy-simple-activator.ts`** — single-step deploy: reads `users` from `factory.users()`, takes `usdcWrapper` + `wsolWrapper` + `factory` as env / defaults, deploys `SimpleActivator` with all wiring resolved. Default per-call cost = 0.5 USDC (× 2 = 1 USDC across both ATA calls).
- **`CLAUDE.md`** — `contracts/activation/` bullet rewritten; Change Impact Map and Cross-repo dependencies tables updated for the three-call ABI; Behavioral contracts notes describe the three-tx pattern.

Replaces `PdaActivator` (deleted in this release — never shipped past unreleased): the prior single-tx Meteora-swap design exceeded the 1.4M-CU cap on chains with the post-clean-slate wrapper stack and was rejected by the rome-sdk pre-flight (`TooManyComputeUnitsInAtomicTx`).

### Removed — `PdaActivator` (single-tx Meteora-swap activation path)
- **`contracts/activation/PdaActivator.sol`** — file deleted.
- **`scripts/activation/deploy-pda-activator.ts`** — file deleted.

### Removed — operator-subsidy `factory.create_user` / `ensure_user` PDA pre-funding
The operator-subsidy PDA-funding path is removed in favor of `SimpleActivator.activate` (user-paid). The earlier `factory.create_user` path was Sybil-vulnerable (operator capital lock-up scaling with user count) and required users to discover an off-path "Claim" button.

- **`ERC20SPLFactory.create_user()`** — function removed.
- **`ERC20SPLFactory.CREATE_PAYER_LAMPORTS`** — constant removed.
- **`ERC20Users.ensure_user`** — now mapping-only; the embedded `RomeEVMAccount.create_payer(user, CREATE_PAYER_LAMPORTS)` call removed.
- **`ERC20Users.CREATE_PAYER_LAMPORTS`** — constant removed.
- **`scripts/bridge/create-user.ts`** — operator-subsidy bootstrap helper deleted.
- **`tests/erc20spl_factory.integration.ts`, `tests/damm_v1_pool.integration.ts`, `tests/damm_v1_router.integration.ts`** — `factory.create_user` calls removed; replaced with comments noting auto-registration via wrapper transfer/approve.
- **`RomeBridgeWithdraw.sol`** — `burnUSDC` / `burnETH` comments updated to point at `SimpleActivator.activate` as the activation prerequisite.

### Fixed — `RomeBridgeWithdraw` aligned with unified-PDA model + correct devnet Wormhole sub-PDAs
Companion to `rome-evm-private` 0acabea ("Remove PAYER seed from user PDA derivation"). With the user's authority and payer collapsed onto a single PDA at `find_program_address([EXTERNAL_AUTHORITY, evm_addr])`, the bridge contract is updated to fill every previously-PAYER_PDA slot with the unified user PDA — matching the rome-ui hooks (`useOutboundCctpSend` / `useOutboundWhSend`) that submit calldata directly to the CPI precompile per `rome-ui/docs/BRIDGE_OUTBOUND_CPI.md`.

- **`RomeBridgeWithdraw.burnUSDC`** — `event_rent_payer` (CCTP `deposit_for_burn` metas[1]) now passes `userPda` (was `userPayerPda`). Salts shrunk from `[bytes32("PAYER"), cctpSalt]` to `[cctpSalt]` (only the per-tx `messageSentEventData` PDA needs an explicit signer seed; the unified user PDA is auto-signed by the precompile when it appears in metas — see `rome-evm-private/program/src/non_evm/cpi_ix.rs:42-66`). Pre-condition: caller's unified PDA must hold ≥ ~13M lamports for `messageSentEventData` rent (factory.create_user pre-funds 50M).
- **`RomeBridgeWithdraw.burnETH`** — same surgery for Wormhole `transfer_wrapped`: `payer` (metas[0]) and `from_owner` (metas[3]) both = `userPda`; salts shrunk from `[bytes32("PAYER"), whSalt]` to `[whSalt]`.
- **`RomeBridgeWithdraw.approveBurnETH`** — now uses `invoke` (not `invoke_signed`); only the unified user PDA signs the SPL Approve, no salt-derived signer.
- **`SPL_ERC20` (`erc20spl/erc20spl.sol`)** — `getAta` / `get_token_account` / `balanceOf` now read the canonical `UserPda.ata(user, mint_id)` instead of the legacy `_accounts` cache (which was empty on freshly-deployed wrappers; bridged-in users had a non-zero balance there but `transfer/approve/transferFrom` returned 0). `ensure_token_account` is lazy: skips the ATA-create CPI when the account already exists on Solana, saving a CPI per repeat-recipient transfer (Romeswap pair.burn / repeat wrapper.transfer paths previously exceeded the per-tx CPI budget). All wrapper SPL CPIs that only need the unified PDA's signature switched from `invoke_signed`-with-empty-seeds to `invoke`.
- **`ERC20Users.CREATE_PAYER_LAMPORTS`** + **`ERC20SPLFactory.CREATE_PAYER_LAMPORTS`** — bumped to **50M** (was 1M). Sized to cover one CCTP outbound (~13M event-account rent) + one Wormhole outbound (~2.5M message rent) + several ATA-creates without manual top-up. Underfunded PDAs previously surfaced as `mollusk error: Failure(Custom(1))` (System Program `ResultWithNegativeLamports`) before the user could top up.
- **Cluster-aware Wormhole sub-PDA derivation in deploy scripts** — `deploy.ts` and `redeploy-withdraw-only.ts` now thread the target network's Wormhole program IDs (devnet vs mainnet differ) into `deriveWormholeAccounts`. The previous default fell through to mainnet IDs; the contract's top-level `wormholeTokenBridgeProgram` immutable would point at devnet `DZnkkTm…` while every sub-PDA (`config`, `authority_signer`, `emitter`, `wrapped_meta`, `bridge_config`, `fee_collector`, `sequence`) was derived against mainnet `wormDTUJ6…` — silent mismatch that caused Wormhole to revert with `Custom(0)`. CCTP IDs match across clusters, so its sub-PDAs were unaffected.
- **`bootstrap-bridged-wrappers.ts`** — `resolveSet` now keys off a `DEVNET_NETWORKS` set (`{marcus, cassius, subura, esquiline, aventine, maximus, local}`) instead of a `["local", "<chain>"]` placeholder, so devnet networks correctly select `SPL_MINTS_DEVNET`.
- **18th meta on `IWormholeTokenBridge.buildTransferWrappedAccounts`** — appended Token Bridge program itself at metas[17] so post-#266 Mollusk emulator's `ix_store` filter can load its ELF for the inner CPI. Wormhole's solitaire ignores trailing accounts; harmless at the bridge layer.
- **18th meta on `ICCTP.buildDepositForBurnAccounts`** — appended MessageTransmitter `__event_authority` at metas[17] for the same emulator reason on the inner `send_message_with_caller` CPI.
- **`scripts/bridge/tests/`** — new directory carrying empirical proofs that the unified-PDA pattern works end-to-end on Marcus devnet: `portal-cctp-test.ts` (CCTP outbound via direct CPI to `0xff…08`), `test-bridgeOutToSolana.ts` (Marcus → Solana SPL bridge), `verify-solana-recipient.ts` (post-bridge recipient ATA verification), `audit-mints.ts` (devnet vs mainnet mint provenance audit). Tx hashes recorded in PR body; CCTP outbound `0x8bac1c79…`, bridgeOutToSolana `0x6512ca18…`.

### Removed — retired chain plumbing (subura, esquiline, cassius, cassius-test, monti_spl)
With every chain except Rome retired in 2026-04 → 2026-05 (Maximus #90, then Subura/Esquiline/Cassius/Cassius-test/Aventine/Caelian/Martius via `/take-down-chain` on 2026-05-01), the per-chain plumbing for the dead networks is removed alongside the registry directory cleanup (`rome-protocol/registry#23`).

- **`hardhat.config.ts`** — dropped 5 network entries: `monti_spl`, `subura`, `esquiline`, `cassius`, `cassius-test`. Remaining live targets: `<chain>`, `local`, `sepolia`, `hardhatMainnet`, `hardhatOp`.
- **`deployments/`** — removed `subura.json`, `esquiline.json`, `cassius.json`, `cassius-test.json`, `monti_spl.json`. Only `rome.json` remains under git tracking (plus `local.json` which is gitignored / per-stack-restart). Per-chain deploy history is preserved in this CHANGELOG.
- **`scripts/oracle/cassius-deploy-fresh-sol-feed.ts`** — deleted. The script existed to deploy a relaxed-staleness Pyth Pull adapter on Cassius's devnet receivers; with Cassius retired and Rome's factory already on `defaultMaxStaleness=86400`, the script has no live target. The general-purpose `deploy-factory.ts` + `deploy-seed-feeds.ts` pair covers any future chain.
- **Comment / docstring scrubs** — `monti_spl` references in `scripts/oracle/*.ts`, `scripts/bridge/{deploy-inbound,constants}.ts`, `scripts/deploy_meteora_factory.ts`, `tests/bridge/RomeBridgeWithdraw.integration.ts`, `tests/oracle/helpers/mockSwitchboard.ts`, `contracts/oracle/{PythPullParser,SwitchboardParser}.sol` rewritten to point at `<chain>`. Two scripts had network-conditional runtime logic on `monti_spl` (`scripts/deploy_meteora_factory.ts` Meteora vault selection, `scripts/bridge/bootstrap-bridged-wrappers.ts` devnet-set selection); both updated to key off the live `["local", "<chain>"]` set.
- **`README.md`** — dropped the `## Deploy Oracle Gateway V2 via GitHub Actions` section (the workflow it referenced — `.github/workflows/deploy-oracle.yml` — was already removed in #74) and rewrote the Meteora deploy snippet + Notes section from `monti_spl` → `<chain>`.
- **`scripts/oracle/README.md` + `scripts/bridge/README.md`** — keystore / deploy snippets reduced to `<chain>` + `local`; the standalone "monti_spl devnet" deploy block removed.
- **`CLAUDE.md`** — every `--network monti_spl` / `--network montispl` example replaced with `--network <chain>`; per-chain Deployment subsections (cassius, subura, esquiline, monti_spl) collapsed into a one-line "earlier devnet chains were retired" pointer; the Networks list reduced to `local`/`<chain>`/`sepolia`/`hardhatMainnet`/`hardhatOp`, with a Decommissioned roll-up. The retired-key keystore lines removed.

The CHANGELOG sections describing past deploys to retired chains are preserved (history not rewritten); this entry simply marks the moment the plumbing for those chains was removed from the live tree.

### Changed — `deployments/rome.json` reconciled against the canonical registry (rome-protocol/registry@v0.4.9)
- `deployments/rome.json` — bulk address refresh to match the now-corrected registry entries for chain 999999-rome. The file had drifted to track an earlier deploy that was superseded on 2026-04-21 (oracle stack) and again on 2026-04-29 (`SPL_ERC20` wrappers + `ERC20SPLFactory`). The local artefact and the registry are now identical for every live address. Cross-link: `rome-protocol/registry#21`.
- `OracleGatewayV2.OracleAdapterFactory`: `0x98d2a1eeafd4595b9df1ad791625d0fb16b081b5` → `0x454f0cde265ecf530a01c5c1bfd1f40d9e0672af`. The previous factory was deployed with `defaultMaxStaleness = 300` which caused USDC and USDT Pyth feeds to revert when their on-chain publish lag exceeded five minutes; the live factory uses `defaultMaxStaleness = 86400` and re-clones every adapter via EIP-1167.
- `OracleGatewayV2.PythPullAdapterImpl`: `0x79380864f61fa5c08bfc98b93d5a55bd71afad35` → `0x23f27d84c5fd53a32baaa52270a22f7b13f241da`.
- `OracleGatewayV2.SwitchboardV3AdapterImpl`: `0xb766b12d163a16ad1f7c1f1bb913e398029e0787` → `0x827a045a8fd1973859ac57df8e801e658e9ed78b`.
- `OracleGatewayV2.BatchReader`: `0x8bc2d008c8fb61daec1ce81276c01f1f234572f3` → `0x0796e4cfdba2acb9aab32abd1722e7845c87acf1`.
- `OracleGatewayV2.defaultMaxStaleness`: `300` → `86400` (matches the live factory).
- `OracleGatewayV2.feeds.pyth[*]` — all 5 adapter clones (SOL/USD, BTC/USD, ETH/USD, USDC/USD, USDT/USD) refreshed to the addresses produced by the new factory; underlying Solana pubkeys unchanged.
- `OracleGatewayV2.feeds.switchboard[0]` (SOL/USD) — adapter refreshed.
- `OracleGatewayV2.feedsVerified[*]` — adapter addresses refreshed to match the new clones for SOL/BTC/ETH so the verified set stays internally consistent.
- `SPL_ERC20_USDC`: `0x6ed2944bba4cb5b1cb295541f315c648658dd67c` → `0x7B4b0bE747AbD982b0E4de5E4a4479FfaC18a81c` (v2, via `ERC20SPLFactory@v2`).
- `SPL_ERC20_WETH`: `0x3e52cfb38ca1639f3c95aef6dccff2b36c230f22` → `0x613b22c098b1058d91731dcb15beaa781b45783e` (v2, with `ensureRecipientAta`).
- `SPL_ERC20_WSOL` (new): `0x1b23b52d9c991d580ae6df1b936aff09a5f794a2`, mint `So11111111111111111111111111111111111111112`. Previously absent from the file; canonical wSOL wrapper.
- `RomeBridgeWithdraw`: `0x513f76e39cfd7008f1e143ae37148608cddfcaaf` → `0x325d62dc31be2b2a6e19e6e5773586e552f7c938` (matches registry `live` entry).
- `ERC20Users`: `0x803f6923bcc776db1d0aa6fcdbd8ceddf35ad6f3` → `0x6a71c3dccc356abe3ffe37e07ed2afb5b3831ce5`.
- `archive` block extended with the previous addresses for `RomeBridgeWithdraw`, `ERC20Users`, `SPL_ERC20_USDC` (v1), `SPL_ERC20_WETH` (v1), and `OracleAdapterFactory` (300s-staleness deploy) so the file retains provenance for the superseded deploys. Mirrors the existing `RomeBridgeWithdrawPrevious` / `RomeBridgeInboundPrevious` convention; no schema changes.

### Changed — `scripts/bridge/deploy.ts` parameterized per-chain via `USDC_MINT` / `WETH_MINT` env vars; `r` symbols swapped to `W`
- `scripts/bridge/deploy.ts` — `loadSolanaPdas` and `main()` no longer read `SPL_MINTS.USDC_NATIVE` / `SPL_MINTS.WETH_WORMHOLE` (Rome's mints) regardless of target. Both now require explicit `USDC_MINT` / `WETH_MINT` env vars at invocation; the script skips the corresponding `SPL_ERC20` wrapper if a mint is unset. `RomeBridgeWithdraw` deploys only when **both** mints are set, since its constructor takes both wrappers and the per-mint Wormhole / CCTP PDAs cannot be derived without them — chains with no Ethereum-origin bridge target therefore get paymaster + ERC20Users + (optional) wrappers, with no broken withdraw artefact written. Surfaced during the cassius-test (121298) bring-up rehearsal — `rome-specs/active/technical/2026-04-28-rome-chain-bring-up-runbook-plan.md` Chapter 10.4 — where the previous default deployed Rome's mints onto cassius-test as throwaway wrappers.
- `scripts/bridge/deploy.ts` — `deployWithdraw(...)` signature gained two trailing string params (`usdcMintBase58`, `wethMintBase58`) so PDAs are derived from the actual deploy-time mints rather than a global. The single in-tree caller (`scripts/setup-local.ts`) updated.
- `scripts/bridge/deploy.ts`, `scripts/setup-local.ts` — wrapper labels updated from the legacy `r` prefix (`Rome USDC` / `rUSDC`, `Rome wETH` / `rETH`) to the canonical `W` prefix per `CLAUDE.md` § "Token nomenclature" (`Wrapped USDC` / `WUSDC`, `Wrapped ETH` / `WETH`). The on-chain `symbol()` of newly-deployed wrappers reads `WUSDC` / `WETH`; existing deployments are unchanged. Aligns the bridge-script wrapper output with WETH9/WBTC convention so Ethereum-familiar users see the symbol they already recognize. `setup-local.ts` was the last remaining call site producing `r`-prefixed symbols in this repo.

### Fixed — `ERC20SPLFactory.TokenCreated` event was declared but never emitted
- `contracts/erc20spl/erc20spl_factory.sol` — `_register_contract` (called from both `add_spl_token_with_metadata` and `add_spl_token_no_metadata`) now emits `TokenCreated(creator, mint, wrapper, name, symbol, nonce)` after writing the `token_by_mint` / `mint_by_symbol_hash` / `token_by_symbol_hash` mappings. Previously the event was declared on lines 26-33 but had zero `emit` sites — so the rome-ui backend's token-discovery indexer (which watches `TokenCreated` per the cross-repo deps note in `CLAUDE.md`) never populated wrappers deployed via this factory. The bootstrap-bridged-wrappers script added in a prior session was relying on an event the factory wasn't emitting; this fix completes that loop. `nonce` carries the creator's current `creator_nonce[msg.sender]` at registration time.
- Surfaced during the cassius-test (121298) bring-up rehearsal — `rome-specs/active/technical/2026-04-28-rome-chain-bring-up-runbook-plan.md` Chapter 10.4 lessons.

### Added — Generic Rome → Solana SPL outbound (`SPL_ERC20.bridgeOutToSolana` + `ensureRecipientAta`)
- `contracts/erc20spl/erc20spl.sol` — new `bridgeOutToSolana(bytes32 recipient, uint256 value) → bool`: single CPI `transfer_checked` from `getATA(AUTHORITY_PDA, mint)` → recipient ATA, signed as `AUTHORITY_PDA = find_program_address([EXTERNAL_AUTHORITY, evmAddr])` with empty seeds. Generic outbound for any wrapper deployed by the factory — one method covers WUSDC/WETH/WSOL today and every future Solana-native SPL. Emits `BridgedOutToSolana`.
- `contracts/erc20spl/erc20spl.sol` — new `ensureRecipientAta(bytes32 recipient) → bytes32`: idempotent single-CPI ATA-create on Solana, paid by sender's pre-funded PAYER PDA. Companion to `bridgeOutToSolana`; the single-tx two-CPI variant fails rome-evm's `eth_call` simulation, so the flow is split. Emits `RecipientAtaEnsured`.
- `contracts/erc20spl/erc20spl.sol` — `balanceOf(address)` now reads `getATA(AUTHORITY_PDA, mint)` instead of the legacy `_accounts` mapping. Bridged-in users (Wormhole `complete_transfer_wrapped`, native deposits) only have balance in `AUTHORITY_PDA`'s ATA; the legacy path returned 0 for them. Same source `bridgeOutToSolana` spends from.
- `scripts/bridge/deploy-weth-v9.ts`, `scripts/bridge/deploy-wsol-v9.ts` — minimal canonical SPL_ERC20 deploys carrying the v9 outbound surface. Use to refresh wrappers on a chain after the contract upgrade.
- `contracts/bridge/README.md` — new "Generic Rome → Solana SPL outbound" section documenting the asset-origin asymmetry: Ethereum-origin assets need CCTP/Wormhole; Solana-native SPLs need only `bridgeOutToSolana`.
- `scripts/bridge/README.md` — bifurcated "Adding a new asset" section by origin (Solana-native SPLs are factory-only; Ethereum-origin assets still need per-asset RomeBridgeWithdraw entrypoints).
- `CLAUDE.md` — "Cross-repo dependencies — rome-ui" section listing every method/event rome-ui consumes and the consumer file path. Mirror section in `rome-ui/CLAUDE.md`.

### Changed — `ERC20SPLFactory.create_user` pre-funds 1,000,000 lamports (was 1,000,000,000)
- `contracts/erc20spl/erc20spl_factory.sol` — `CREATE_PAYER_LAMPORTS = 1_000_000` (was 1B inline). 1M is above the 0-byte rent-exempt minimum (~890,880) but below subsequent operation costs (~2,039,280 per ATA create). Per `/rome/CLAUDE.md`'s "no faucets, no starter-gas-on-us" rule — bridging / ATA-creation lamports come from user funds going forward. ABI is unchanged; only the internal constant differs. Existing users on the deployed factory keep their previously-pre-funded balance.

### Added — Bridged-wrapper bootstrap script
- `scripts/bridge/bootstrap-bridged-wrappers.ts` — registers the canonical bridged SPL mints (USDC, WETH) on a chain's `ERC20SPLFactory` via `add_spl_token_no_metadata`. The factory's `TokenCreated` event is what the rome-ui backend's token watcher consumes to populate Portfolio / Swap / TokenSelectModal; wrappers deployed by direct `new SPL_ERC20(...)` (legacy bridge redeploy scripts) bypass that event and stay invisible in the UI. Run after `scripts/deploy_erc20spl_factory.ts` on a fresh chain — the script is idempotent (skips mints with a non-zero `token_by_mint`) and writes resulting wrapper addresses into `deployments/<network>.json` under `SPL_ERC20_USDC` / `SPL_ERC20_WETH`. Mint set is auto-selected per network (devnet vs mainnet); override via `BRIDGED_SET=devnet|mainnet` for one-offs.

### Added — Oracle Gateway V2 GitHub Actions deploy workflow
- `.github/workflows/deploy-oracle.yml` — manual-trigger (`workflow_dispatch`) workflow that deploys Oracle Gateway V2 (core + seed feeds + verification) against a selected Rome devnet using a single shared GitHub Secret (`ROME_DEVNET_PRIVATE_KEY`). Posts the resulting `deployments/<network>.json` back as a reviewable bot PR via `peter-evans/create-pull-request` when `open_pr: true`. Toggles: `run_seed_feeds`, `run_verification`, `open_pr`, `force_redeploy`. Closes #33.
- `hardhat.config.ts` — added `subura` (chainId 121222) and `esquiline` (chainId 121225) network entries; deduplicated the `<chain>` block and added its explicit `chainId 999999`.
- `README.md` — new "Deploy Oracle Gateway V2 via GitHub Actions" section documenting the required secret and trigger flow.

### Changed — Oracle Gateway V2 deploy scripts: idempotency + naming
- `scripts/oracle/deploy-v2-polish.ts` — now idempotent. If `deployments/<network>.json` already contains a populated `OracleGatewayV2` block, the script prints existing addresses and exits without deploying. Set `FORCE_REDEPLOY=1` to override. Previously every invocation redeployed unconditionally, which wasted gas and orphaned the prior deploy on every CI run.
- Deploy block renamed: `OracleGatewayV2Polished` → `OracleGatewayV2`. The "Polished" suffix existed only because a parallel legacy `OracleGatewayV2` block was being preserved during the audit refactor; that block is now an artifact and has been renamed to `OracleGatewayV2Legacy` in `deployments/monti_spl.json` (the only file that carried it; `monti_spl` itself is retired). `deploy-seed-feeds.ts` and `test-feeds-v2.ts` updated to the new name. `test-feeds-v2.ts` also fixed to read the current plain-string address shape (previously still expected the old `{address: "0x..."}` nesting from `deploy.ts`).
- `deployments/rome.json` — block renamed. Addresses refreshed by a dry-run of the workflow against `<chain>`; **downstream consumers (rome-oracle-portal, etc.) must update their rome V2 addresses**.

### Changed — Rome Bridge Phase 1 outbound Wormhole target chain
- `contracts/bridge/RomeBridgeWithdraw` — added `wormholeTargetChain` immutable constructor param; `burnETH` now uses that instead of a hardcoded `2`. Wormhole testnet Sepolia is chain id 10002, not 2 (which is Ethereum mainnet). Without this, outbound VAAs targeted the wrong chain and the Sepolia Token Bridge refused to redeem them with `"invalid target chain"`.
- `scripts/bridge/deploy.ts`, `redeploy-withdraw-devnet-wh.ts`, `redeploy-withdraw-canonical-weth.ts` — set `targetChain: 10002` for rome/local (Sepolia). `redeploy-withdraw-only.ts` sets `targetChain: 2` for the mainnet path.
- `scripts/bridge/outbound-wh-e2e.ts`, `scripts/bridge/e2e-all-four.ts` — full end-to-end runners (source burn, Solana sig lookup, VAA/attestation poll, destination redemption).

### Changed — Rome Bridge Phase 1 bring-up fixes (rome devnet)
- `contracts/bridge/RomeBridgeWithdraw` — split outbound Wormhole into two EVM txs: new `approveBurnETH(uint256)` does the SPL Token Approve CPI; existing `burnETH(uint256,address)` now does only `transfer_wrapped`. Single-tx flow exceeded Solana's 1.4M compute-unit budget (Rome DoTx overhead ~1.3M CU leaves too little for Wormhole + SPL Token burn). Matches the standard "approve then bridge" pattern.
- `scripts/bridge/constants.ts` — `SPL_MINTS_DEVNET.WETH_WORMHOLE` updated to the canonical wrapped-Sepolia-ETH mint `6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs` (was a stale test mint `2kCwKG…`). Derived from `deriveCanonicalWrappedMint({ tokenChain: 10002, tokenAddress: "eef12a83…" })` and verified on chain. Keeps `wrappedMeta` PDA in sync with the deployed rETH wrapper; stops Wormhole returning "Unexpected length of input" on an empty PDA.
- `scripts/bridge/submit-burnETH.ts` — sends `approveBurnETH` then `burnETH` (two-step E2E). Reads addresses from `deployments/rome.json`.

### Added — Bridge setup + diagnostics
- `contracts/bridge/README.md` — architecture overview, flow diagrams, and a problems-and-fixes runbook (8 real incidents with root cause and fix), redeploy procedure.
- `scripts/bridge/allowlist-approve-selector.ts` — one-shot that allowlists `approveBurnETH(uint256)` on the paymaster for the current `RomeBridgeWithdraw`. Run after redeploy so ERC-2771 sponsorship works for the two-step outbound Wh flow.
- `scripts/bridge/smoke-emulate-all.ts` — verifies `burnUSDC` and `approveBurnETH` emulate cleanly on the current deployment.

### Added — Rome Bridge Phase 1 (Solidity contracts)
- `contracts/bridge/RomeBridgePaymaster` — EIP-2771 trusted forwarder. Sponsors up to 3 Rome EVM transactions per user via a `(target, selector)` allowlist. Budget is only consumed when a request is actually dispatched (fixes `executeBatch` drain vector).
- `contracts/bridge/RomeBridgeWithdraw` — accepts rUSDC / rETH burn from a Rome EVM user, emits outbound Wormhole Token Bridge or CCTP `depositForBurn` messages via CPI signed as the user's Rome-derived PDA.
- `contracts/bridge/IWormholeTokenBridge.sol` — `WormholeTokenBridgeLib` with `transfer_tokens` instruction encoder and 18-account layout.
- `contracts/bridge/ICCTP.sol` — `CCTPLib` with `deposit_for_burn` instruction encoder and 13-account layout.
- `contracts/bridge/RomeBridgeEvents.sol` — shared `Withdrawn` and `PaymasterSponsored` events.
- `contracts/erc20spl/erc20spl.sol` — public `getAta(address user)` reader for the user's SPL token account.
- `scripts/bridge/deploy.ts` — deploy script for paymaster, SPL_ERC20 wrappers (rUSDC, rETH), and withdraw. All Solana pubkeys supplied at construction via `CctpParams` / `WormholeParams`.
- `scripts/bridge/derive/cctp-accounts.ts`, `scripts/bridge/derive/wormhole-accounts.ts` — PDA derivation helpers for the 14 Solana accounts required by `RomeBridgeWithdraw`.
- `scripts/lib/pubkey.ts` — `base58ToBytes32` helper.
- `tests/bridge/RomeBridgePaymaster.test.ts` — 11 unit tests on hardhatMainnet.
- `tests/bridge/RomeBridgeWithdraw.test.ts` — 7 error-path unit tests on hardhatMainnet.
- `tests/bridge/derive.test.ts` — 6 PDA-derivation unit tests.
- `tests/bridge/RomeBridgeWithdraw.integration.ts` — integration test scaffold; requires running local Rome stack or `monti_spl` devnet + seeded balances.

### Dependencies
- Added `@openzeppelin/contracts ^5.6.1` (for `ERC2771Forwarder`, `ERC2771Context`, `Ownable`).
- Added `bs58` (base58-to-bytes32 conversion in deploy scripts).
- Added `@solana/web3.js` (PDA derivation in deploy scripts).

### Spec
See `rome-product/specs/rome-bridge-phase1.md` for the full design spec (Variant B auto-redeem, USDC as Rome EVM gas token, Wormhole + CCTP sequencing).

## [Unreleased]

### Added
- Agent Execution Guide and Change Impact Map in CLAUDE.md
- PR and issue templates for standardized contributions
- CI pipeline with Hardhat compile and test stages

### Fixed

- **`SPL_ERC20.transfer` / `transferFrom` / `mint_to` no longer revert when the recipient has never received the wrapper.** Previously the destination ATA was resolved via `get_token_account(to)`, which reverts with `"Token account does not exist"` when the recipient has not been registered. Sending a wrapper to a fresh wallet (no prior bridge inbound, no prior receive) was therefore impossible; MetaMask's `eth_call` simulation surfaced the revert as a greyed-out Send button.
  - `_transfer` and `mint_to` now call `ensure_token_account(to)` instead, which creates the recipient's PDA-owned ATA via `create_associated_token_account_idempotent` on first encounter and is a no-op on subsequent calls. Same UX model as Phantom and every other Solana wallet — sender pays the one-time ~0.002 SOL rent for the recipient's ATA.
  - `get_token_account` is still used for the sender's ATA in `_transfer` and for `allowance` / `approve` (sender must already hold tokens to transact, so their ATA is guaranteed to exist).
  - Test coverage: two new cases in `tests/erc20spl_factory.integration.ts` — transfer to a fresh address and `mint_to` to a fresh address. Pre-fix both reverted with `"Token account does not exist"`; post-fix both land and the recipient's `balanceOf` reflects the move.
  - Existing wrapper deployments (e.g. wUSDC at `0x1be9bC…` on rome) carry the pre-fix bytecode and need a redeploy + chain-config swap to pick up this fix; the contract change itself is non-breaking.

## 2026-04-20 — Oracle Gateway V2 Polish

### Added
- `IAdapterMetadata` interface with `OracleSource` enum (Pyth=0, Switchboard=1).
- `metadata()` view on `PythPullAdapter` and `SwitchboardV3Adapter` returning description, sourceType, Solana account, maxStaleness, `createdAt`, factory address, and live paused state in a single struct. Removes the need for off-chain event indexing to describe a feed.
- `BatchReader.getFeedHealth(address[])` returning per-feed `FeedHealth` with aggregated healthy/stale/paused status, latest price, and time since update. Uses per-adapter try/catch isolation plus a codeless-address short-circuit so one broken feed does not poison the batch.
- Staleness bounds `[1s, 24h]` enforced across the factory (constructor + `setDefaultMaxStaleness`) and both adapter `initialize()` methods. New error `StalenessOutOfRange(uint256)`.
- Fuzz tests for `PythPullParser` and `SwitchboardParser` — 50 random byte-mutation iterations per parser verify the parse-or-revert property (no silent garbage returns).
- Inline derivation comments for the Pyth (`0x22f123639d7ef4cd`) and Switchboard (`0xd9e64165c9a21b7d`) Anchor discriminators.
- GitHub Actions workflow `oracle-offset-validation.yml` running Pyth + Switchboard parser offset validation on every PR touching `contracts/oracle/**` and weekly on Mondays at 00:00 UTC. Slack alert on cron failure.
- `<chain>` devnet network in `hardhat.config.ts` (chainId 999999, endpoint `https://rome.devnet.romeprotocol.xyz`).
- Deployment scripts `scripts/oracle/deploy-v2-polish.ts` and `scripts/oracle/deploy-seed-feeds.ts` — coordinated redeploy + idempotent seed rollout per `--network`.

### Changed
- Polished Oracle Gateway V2 stack redeployed on `<chain>` devnet under `OracleGatewayV2Polished` in `deployments/rome.json`:
  - `OracleAdapterFactory` → `0x0164b98c1e9d9d25f4c9d3f617d1aaf5ca28efce`
  - `PythPullAdapterImpl` → `0xc91f5528b1529e0b2ca2b89b5c5632acad88bc09`
  - `SwitchboardV3AdapterImpl` → `0xebf4695cd79f2ec4cf36861bcc0b59c6d1a630d8`
  - `BatchReader` → `0x83d32d9a70dfc02fadcffff2d5d7f8d3c03fb314`
- Seeded 5 Pyth feeds (SOL/USD, BTC/USD, ETH/USD, USDC/USD, USDT/USD) and 1 Switchboard feed (SOL/USD) on rome.

### Deprecated
- Prior `OracleGatewayV2` block in `deployments/monti_spl.json` — `monti_spl` devnet has been retired. `<chain>` is the current development target. Legacy addresses remain on-chain at `monti_spl` but are no longer tracked.
