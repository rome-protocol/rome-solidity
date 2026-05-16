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
- **Gas ↔ SPL wrapper conversion (`Withdraw.withdraw_to_ata` for wrap, `HelperProgram.deposit_from_ata` for unwrap) must present WETH9-`deposit()`/`withdraw()`-equivalent UX.** Same external call shape, same event semantics, same refund-on-excess-value behavior as Uniswap's canonical WETH. The user-facing helper (rome-ui's `useWrapUnwrap`) wraps these two precompile calls so consumers don't need to know about the underlying split. The retired pre-2026-05-12 precompiles `wrap_gas_to_spl(0x42..18)` / `unwrap_spl_to_gas(0x42..17)` are no longer dispatched.

When adding new contracts:

- **Start from the Ethereum canonical interface.** If a pattern exists on Ethereum (ERC20, ERC721, AggregatorV3, UniswapV2, etc.), use that interface. **Extend** in a separate `I<Thing>Extended.sol` — never modify the base interface, never replace it with a Rome-specific alternative.
- **Rome-specific helpers (CPI, PDA derivation, mint layout) go in `*_program.sol` / `*_lib.sol` modules**, not in the public contract surface. Keep the public surface EVM-standard.
- **Don't write "free to the user" primitives** (airdrop, faucet, subsidized mint). Token issuance goes through explicit bridge flows, swaps, or contract-owned admin — never zero-cost user claims.

## Token nomenclature — canonical, repo-wide

**This is the standard. Documentation, code comments, error messages, and UI strings all follow it.** When you write about a Rome token, pick the right form:

| Token kind | Display symbol | Example |
|---|---|---|
| **Native gas** of a Rome chain | **bare underlying symbol** — no prefix | `USDC` (Rome's gas mint), `ETH` (a hypothetical ETH-gas chain), `SOL` (a hypothetical SOL-gas chain) |
| **ERC20-SPL wrapper** (any `SPL_ERC20` deployed via the factory or bridge scripts) | **lowercase `w` prefix** | `wUSDC` (Rome's USDC-mint wrapper), `wETH` (Wormhole-wrapped Sepolia-ETH wrapper), `wSOL` (canonical wSOL wrapper), `wJUP`/`wBONK`/`wUSDT` (future long-tails) |

### Rules

1. **Native gas keeps its underlying name.** On Rome the gas mint is USDC, so the native gas is `USDC`. On a SOL-gas chain it's `SOL`. **No prefix, ever**, on the native gas symbol.
2. **Every ERC20-SPL wrapper gets `w`.** This is true even for wrappers of the gas mint itself (Rome has `USDC` native gas AND `wUSDC` as the SPL_ERC20 wrapper of the same SPL — two distinct tokens, two distinct displays).
3. **Lowercase `w`** — matches the on-chain `SPL_ERC20.symbol()` value the factory writes. Verified on Marcus: the deployed wUSDC + wETH wrappers report lowercase. Display layer aligns with on-chain truth so portfolio labels match what users see in MetaMask + the block explorer + their wallet token list. Not capital `W`, not legacy `r`.
4. **The on-chain `symbol()` IS the display form.** This is the change from the previous (capital-W) convention: where the old rule said the W-prefix was a UI-side override, the new rule is "match what the contract was deployed with". When deploying a new wrapper, set the on-chain symbol to `w{Underlying}` (lowercase). The canonical UI helper is [`rome-ui/src/utils/displayTokenSymbol.ts: wrapperSymbolFor(gasSymbol)`](https://github.com/rome-protocol/rome-ui/blob/main/src/utils/displayTokenSymbol.ts) which returns `w{symbol}` (lowercase, matching).
5. **Old `r` prefix (Rome) is deprecated.** `rUSDC`, `rETH`, `rSOL` were the legacy forms before alignment with the WETH/WBTC pattern. Don't introduce new `r`-prefixed names; when you find an existing one, fix it. Historical CHANGELOG entries that describe past state may keep the old names — don't rewrite history, but flag them as historical.
6. **Old capital-`W` convention is also deprecated.** Earlier docs/code used `WUSDC`/`WETH` as a display-layer override on top of contracts that shipped with `symbol: "USDC"`. The current rule is to match on-chain truth (lowercase `w`); legacy WETH9-style mainnet contracts are unrelated and keep their canonical uppercase names.

### Why this matters

Ethereum users coming from MetaMask / Uniswap recognize the `w` prefix from Wormhole-wrapped assets (Wormhole writes wUSDC, wETH, wSOL on-chain across networks). The Rome design principle ([`/rome/CLAUDE.md`](../CLAUDE.md) "Ethereum-equivalent, not Ethereum-lite") is to **preserve patterns users already know AND keep on-chain truth as the single source**. Lowercase `w` satisfies both: it matches the deployed contract symbols, and it matches what the user sees in their wallet without a UI translation step that can drift from reality.

### Cross-repo enforcement

This standard applies to every Rome sub-repo that ships user-visible strings or describes tokens in docs. The mirror reference lives in [`rome-ui/CLAUDE.md`](../rome-ui/CLAUDE.md). When you spot a stale `r`-prefix in any sub-repo, fix it in place — there's no migration window or feature flag, this is a one-edit-then-done change everywhere.

---

## Configuration / chain metadata — canonical at rome-registry

Chain ids, contract addresses, token registries, gas pool derivations, oracle feeds, and bridge wiring come from **[`rome-protocol/registry`](https://github.com/rome-protocol/registry)**. Don't hardcode in this repo.

- **`scripts/bridge/constants.ts`** carries Solana program IDs and bridged-mint addresses today. Phase 3 of the registry migration plan converts this to a thin re-export from `@rome-protocol/registry`. Until then, keep aligned with `https://cdn.jsdelivr.net/gh/rome-protocol/registry@v0.2.0/solana/programs/<network>.json` and `protocols/{cctp,wormhole}.json`.
- **`deployments/<network>.json`** is the local artifact written by deploy scripts. Authoritative copy lives at `rome-protocol/registry` under `chains/<id>-<slug>/contracts.json`. Treat the local file as a deploy receipt; surface canonical addresses via the registry.
- The `tools/add-chain.ts --deployments-from <path>` CLI in the registry repo accepts these JSON files as input — that's the bridge from local-deploy-artifact → canonical-registry-PR.
- Browser fetch / NPM import patterns: see [registry README](https://github.com/rome-protocol/registry).

If you find a chain id or contract address hardcoded in this repo that's already in the registry, that's a drift bug — fix it.

## Build & Test Commands

```bash
npm install                # install dependencies
npx hardhat compile        # compile all contracts (Solidity 0.8.28)

# Run tests (requires local Rome-EVM node or a live Rome devnet chain)
npx hardhat test tests/damm_v1_pool.integration.ts --network local

# Run oracle parser tests (uses hardhat simulated network)
npx hardhat test tests/oracle/PythPullParser.test.ts
npx hardhat test tests/oracle/SwitchboardParser.test.ts

# Deploy (requires env vars or hardhat keystore)
npx hardhat run scripts/deploy_meteora_factory.ts --network <chain>
npx hardhat run scripts/deploy_meteora_pool.ts --network <chain>

# Deploy Oracle Gateway V2
npx hardhat run scripts/oracle/deploy.ts --network <chain>
npx hardhat run scripts/oracle/deploy-factory.ts --network <chain>
npx hardhat run scripts/oracle/deploy-and-test.ts --network <chain>  # end-to-end deploy + test

# Test oracle feeds on live network
npx hardhat run scripts/oracle/test-feeds.ts --network <chain>       # Pyth v1 feeds
npx hardhat run scripts/oracle/test-feeds-v2.ts --network <chain>    # Oracle Gateway V2 (Pyth Pull + batch reader)
npx hardhat run scripts/oracle/test-switchboard.ts --network <chain> # Switchboard V2 feeds

# Validate oracle parser offsets against live accounts
npx hardhat run scripts/oracle/validate-pyth-pull-offsets.ts --network <chain>
npx hardhat run scripts/oracle/validate-switchboard-offsets.ts --network <chain>

# Debug/inspect oracle accounts
npx hardhat run scripts/oracle/check-account-owner.ts --network <chain>
npx hardhat run scripts/oracle/check-switchboard.ts --network <chain>

# Deploy bridge contracts (requires USDC_MINT / WETH_MINT env vars per chain)
npx hardhat run scripts/bridge/deploy.ts --network <chain>

# Bootstrap factory-registered SPL wrappers (idempotent; run after factory deploy)
npx hardhat run scripts/bridge/bootstrap-bridged-wrappers.ts --network <chain>

# Local Rome stack setup (requires rome-setup stack running)
npx hardhat keystore set LOCAL_PRIVATE_KEY --dev   # Hardhat #0: ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
npx hardhat run scripts/setup-local.ts --network local  # deploys Meteora factory+pool, Oracle Gateway V2, Pyth+Switchboard feeds

# Run integration tests against local stack
npx hardhat test tests/damm_v1_pool.integration.ts --network local
npx hardhat run scripts/oracle/test-switchboard.ts --network local
npx hardhat run scripts/oracle/test-feeds-v2.ts --network local

# Set keys in dev keystore
npx hardhat keystore set <CHAIN>_PRIVATE_KEY --dev
```

## CI & Release Tracking

- **CI** (`.github/workflows/ci.yml`): runs on push/PR to `master` with Node 22. Stages: `npm ci`, `npx hardhat compile`, `npx hardhat test` (oracle parser unit tests — network-independent). Integration tests requiring `local` or a live devnet are not run in CI.
- **No CI-driven contract deploys.** The `deploy-oracle.yml` workflow was removed (#74) — every deploy (Oracle, Bridge, ERC20SPL, Meteora) uses the manual local-keystore flow. If CI-driven deploys are needed in the future, they belong in a dedicated private deploy-runner repo with per-network GitHub Environment gating.
- **CHANGELOG.md** — user-facing changes tracked by session. Update when a PR lands user-visible behaviour changes (new contracts, API shifts, deployment changes). Parser/offset changes also belong here because they affect downstream deployments.
- **PR / issue templates** live under `.github/` and enforce the session-readiness checklist.

## Architecture

### Rome-EVM Precompile Interfaces (`contracts/interface.sol`)

The core abstraction layer. Rome-EVM exposes Solana programs as EVM precompiles at fixed addresses. **Authoritative inventory of upstream Rust dispatch + selector hex lives in [`rome-evm-private/CLAUDE.md`](../rome-evm-private/CLAUDE.md)** — when adding a method, treat the Rust side as canonical and mirror here.

| Precompile | Address | Interface | Source of truth |
|---|---|---|---|
| System Program | `0xff..07` | `ISystemProgram` — PDA derivation, base58, mint/operator/program-id getters | `program/src/non_evm/system.rs` |
| CPI | `0xff..08` | `ICrossProgramInvocation` — arbitrary Solana CPI + 4 CU-shortcut selectors | `program/src/non_evm/cpi.rs` |
| Helper Program | `0xff..09` | `IHelperProgram` — 14 selectors for SPL / PDA / ATA / lamports / gas-token plumbing | `program/src/non_evm/helper.rs` |
| Withdraw | `0x42..16` | `IWithdraw` — SOL `withdrawal` + the two gas-token bridge legs (`withdraw_to_pda` / `withdraw_to_ata`) | `program/src/non_evm/withdraw.rs` |

Global constants pre-bound by `interface.sol`: `SystemProgram`, `CpiProgram`, `HelperProgram`, `Withdraw`.

**Removed precompiles** (kept here so agents recognize stale code):

- `0xff..05` (SPL Token) and `0xff..06` (Associated Token) — dedicated handlers were removed in the rome-evm-private Mollusk refactor; SPL operations now route through Mollusk SVM in the emulator and CPI on-chain. The `ISplToken` / `IAssociatedSplToken` interfaces and `SplToken` / `AssociatedSplToken` constants are no longer in `interface.sol`.
- `0x42..17` (`unwrap_spl_to_gas(uint256)`) and `0x42..18` (`wrap_gas_to_spl(uint256)`) — replaced 2026-05-12 by `Withdraw.withdraw_to_ata(uint256)` (wrap leg: gas → wrapper ATA) and `HelperProgram.deposit_from_ata(uint256)` (unwrap leg: wrapper ATA → gas). The `IUnwrapSplToGas` / `IWrapGasToSpl` interfaces and their pre-bound constants are no longer in `interface.sol`. Migration sequence: rome-solidity PR #137 → #138 → #141 → #143 paired with rome-evm-private #348 / #349 / #351 / #352 / #353 / #354.

#### `CpiProgram` shortcut selectors (`0xff..08`)

(rome-evm-private PRs #318 / #319 / #320, shipped 2026-05-06; trimmed 2026-05-12 — `spl_transfer_checked_v1` + `derive_user_ata` migrated into `HelperProgram` under cleaner names):

| Selector | Signature | Purpose |
|---|---|---|
| `0x7480cb86` | `invoke(bytes32, AccountMeta[], bytes)` | Arbitrary Solana CPI, caller as signer |
| `0xb94f3733` | `invoke_signed(bytes32, AccountMeta[], bytes, bytes32[])` | CPI signed by N caller-derived PDAs (salts → seeds) |
| `0xc13465d9` | `account_info(bytes32 pubkey) → (uint64, bytes32, bool, bool, bool, bytes)` | Full Solana `AccountInfo` marshal — lamports/owner/flags/data |
| `0x593762e8` | `account_data_at(bytes32 pubkey, uint16 offset, uint16 length) → bytes` | Generic typed-slice read of any Solana account |
| `0xb317d4c1` | `account_u64_at(bytes32 pubkey, uint16 offset) → uint64` | u64 LE read — saves ABI-encode roundtrip for the most common shape |
| `0xde79ed54` | `account_lamports(bytes32 pubkey) → uint64` | Lamports-only probe — skips data buffer fetch |
| `0x944336f8` | `pdas_batch_derive(bytes[][] seed_groups, bytes32 program_id) → (bytes32 pda, uint8 bump)[]` | N independent PDAs against one program in one dispatch (N ≤ 16, M ≤ 8 seeds) |

#### `HelperProgram` surface (`0xff..09`)

The post-consolidation home for Rome-specific Solana plumbing that EVM contracts repeatedly need. Every method below was verified via `cast keccak <sig>` against the const in `rome-evm-private/program/src/non_evm/helper.rs` on 2026-05-13.

| Selector | Signature | Purpose |
|---|---|---|
| `0x5a7c3259` | `create_ata(address user)` | Create user's ATA for the chain's gas mint. Gas-token chains only. |
| `0x3de2251a` | `create_ata(address user, bytes32 mint)` | Create user's ATA for an arbitrary SPL mint. |
| `0xff3556ca` | `create_pda(address user)` | Create user's `external_auth` PDA (no lamports). |
| `0x58e88298` | `create_pda(address user, uint64 lamports)` | Create user's `external_auth` PDA with seed lamports. |
| `0x6e3f24e0` | `swap_gas_to_lamports(uint64 lamports)` | Swap gas-token for SOL lamports against the operator. |
| `0x5fe71665` | `transfer_lamports(address to, uint64 lamports)` | Transfer lamports between `external_auth` PDAs. |
| `0xb12be5ba` | `transfer_spl(address to, uint64 tokens)` | SPL transfer of gas mint between user PDAs' ATAs (gas-mint chains only). |
| `0xba3a5eac` | `transfer_spl(bytes32 to_ata, uint64 tokens)` | Same as above, recipient given as raw ATA pubkey. |
| `0x53b505e0` | `transfer_spl(address to, uint64 tokens, bytes32 mint)` | Arbitrary-mint variant of the address-keyed overload. |
| `0xb6977879` | `transfer_spl(bytes32 to_ata, uint64 tokens, bytes32 mint)` | Arbitrary-mint variant of the raw-ATA overload — used by `SPL_ERC20.bridgeOutToSolana`. |
| `0x766b362a` | `transfer_spl(bytes32 src_ata, bytes32 to_ata, uint64 tokens, bytes32 mint)` | **Delegate variant.** Caller-supplied `src_ata` instead of derived. Signs as `external_auth(caller)`; SPL Token accepts the PDA as ATA owner OR delegate (delegated_amount ≥ tokens). Required by `SPL_ERC20._transfer` when `from != msg.sender` (PR #143). |
| `0x8854a299` | `pda(address user) view → bytes32` | Returns `external_auth(user)` — replaces the prior `RomeEVMAccount.pda` helper for new code. |
| `0x31db4f82` | `ata(address user) view → bytes32` | User's gas-mint ATA. Gas-mint chains only. |
| `0xfeb1c647` | `ata(address user, bytes32 mint) view → bytes32` | User's ATA for an arbitrary mint. Replaces the old `CpiProgram.derive_user_ata(0xc654e119)` shortcut; `UserPda.ata(user, mint)` now delegates here. |
| `0xabf6f675` | `approve_spl(address spender, uint64 amount, bytes32 mint)` | Caller-PDA-as-owner sets `delegate_pda(spender)` on owner-ATA via SPL `approve_checked`. Replaces v1 `SPL_ERC20.approve`'s Solidity-side `SplTokenLib.approve` + raw `invoke_signed` marshaling. Saves ~150-200K CU per call. |
| `0xc9884b1e` | `approve_spl(address spender, uint64 amount, bytes32 mint, bytes32 token_program)` | Same with explicit `token_program` (Token-2022-ready). |
| `0xd795522b` | `mint_spl(address to, uint64 amount, bytes32 mint)` | Caller-PDA-as-mint-authority mints to dest user's ATA via SPL `mint_to_checked`. SPL Token runtime enforces caller-PDA == on-chain mint authority. Replaces v1 `SPL_ERC20.mint_to`'s Solidity-side `SplTokenLib.mint_to_checked` + `invoke` marshaling. |
| `0x406ee21b` | `mint_spl(address to, uint64 amount, bytes32 mint, bytes32 token_program)` | Same with explicit `token_program`. |
| `0xe479df56` | `transfer_spl(address from, address to, uint64 amount, bytes32 mint)` | **Addr-keyed delegate variant.** Derives both ATAs from EVM addresses internally; signs as `external_auth(caller)`. SPL Token accepts PDA as owner OR delegate. Replaces `SPL_ERC20.transferFrom`'s prior bytes32-ATA delegate variant (`0x766b362a`). |
| `0x7b11c48f` | `transfer_spl(address from, address to, uint64 amount, bytes32 mint, bytes32 token_program)` | Same with explicit `token_program`. |
| `0xdd0119c8` | `user_balance(address account, bytes32 mint) view → uint64` | Read SPL TokenAccount.amount (u64 LE at offset 64) on user's PDA-owned ATA. Returns 0 if ATA doesn't exist (fresh-chain probe). Collapses 3 v1 dispatches (`ata` + `lamports` + `readU64At`) into one CrossStateEthCall. Backs `SPL_ERC20.balanceOf`. |
| `0xed72dbc8` | `allowance_of(address owner, address spender, bytes32 mint) view → uint64` | Read owner-ATA's `delegated_amount` IFF on-chain delegate matches `external_auth(spender)` (HARD REQ in Rust to enforce ERC-20 semantics; otherwise routers probe non-zero allowance when actual delegate is someone else). Collapses 5 v1 dispatches into one. Backs `SPL_ERC20.allowance`. |
| `0x4479b709` | `deposit_from_ata(uint256 wei_)` | Move wrapper SPL balance from caller's ATA into gas-token credit. Unwrap leg of the gas-wrapper bridge. |

#### `Withdraw` surface (`0x42..16`)

| Selector | Signature | Purpose |
|---|---|---|
| `0x4d8b0ea4` | `withdrawal(bytes32 owner) payable` | Move EVM-side wei to a Solana wallet (`owner`) as SOL. Pre-existing flow; unchanged. |
| `0x7f3124a0` | `withdraw_to_pda(uint256 wei_)` | Withdraw wei to caller's `external_auth` PDA as gas-token wrapper SPL. Single-state-only. |
| `0x8059abc0` | `withdraw_to_ata(uint256 wei_)` | Withdraw wei to caller's PDA-owned ATA. **Wrap leg of the gas-wrapper bridge** (replaces the retired `wrap_gas_to_spl(0x42..18)` precompile). Single-state-only. |

#### Adoption status as of 2026-05-13

- **`HelperProgram.ata(address, bytes32)`** is now the canonical EVM → SPL ATA lookup. `UserPda.ata` delegates to it; `SPL_ERC20.getAta` / `balanceOf` / `_transfer` / `ensure_token_account` and all three CCTP+Wormhole burn paths in `RomeBridgeWithdraw` call it directly. Behaviour is byte-identical to the prior two-hop `find_program_address` derivation.
- **`HelperProgram.transfer_spl(bytes32, bytes32, uint64, bytes32)` (4-arg delegate variant)** is the one transfer overload that supports `transferFrom`-style flows where the caller-PDA is the SPL delegate of the source ATA's owner. Used by `SPL_ERC20._transfer` (#143).
- **`Withdraw.withdraw_to_ata` + `HelperProgram.deposit_from_ata`** are the two legs of the gas-token wrap/unwrap flow. Consumed end-to-end by rome-ui's `src/features/portfolio/hooks/useWrapUnwrap.ts` (ported in rome-ui PR #245, merged 2026-05-14).
- **`pdas_batch_derive`**: surfaced as the **`PdasBatch` library** (`contracts/cpi/PdasBatch.sol`) since 2026-05-15. Use `PdasBatch.derive(seedGroups, programId)` for arbitrary N (≤ 16); `PdasBatch.pair`/`triplet`/`quad` for the common shapes. First production consumer ships in the paired Meteora migration PR — `_derive_permissionless_pool_with_config_keys`. Worked example: `contracts/examples/pdas_batch.sol`. Cardo adapters that derive 3+ PDAs per call (Drift, Mango, Meteora, Raydium, Kamino) should adopt the same library — distinct precompile call path from single-PDA `PdaDeriver` (`0xFF…08` selector `0x944336f8` vs `0xFF…07`), so import both side-by-side when a contract needs each.

**Measured CU saving** (Marcus 121301, 3-sample average, 2026-05-11): a probe contract that does the OLD two-hop (`RomeEVMAccount.pda` + `AssociatedSplToken.get_associated_token_address_with_program_id`) consumed ~281K CU on Solana; the same probe via the unified-derive selector (now `HelperProgram.ata(address, bytes32)`) consumed ~129K CU — **~152K CU saved per call, 54 % reduction**. EVM `gasUsed` is NOT a reliable proxy for Solana CU on Rome — use the Solana-side `computeUnitsConsumed` from the proxy's Solana tx receipt. The bare `0xFF…07` `find_program_address` round-trip costs ~115K CU per hop end-to-end — far above the "1500 CU per `find_program_address` syscall" line in the [CU strategy spec](../rome-specs/active/technical/2026-04-25-rome-evm-cu-and-multi-hop-cpi-strategy.md), because of the EVM-side ABI marshaling + Solana atomic-tx wrapper overhead.

**Hadrian re-measurement, full primitive surface (2026-05-14):** see [`rome-specs/active/technical/2026-05-14-rome-primitive-cu-baseline.md`](../rome-specs/active/technical/2026-05-14-rome-primitive-cu-baseline.md). Probe contract `0x20137b68A4459c6e18fd682C0Fc437A6849F5c7e` exercises every Rome precompile primitive (PDA / ATA derive, account reads, wrap/unwrap, SPL transfer 3-arg / 4-arg delegate / legacy) and captures real on-chain Solana CU. Headline confirmations + new findings:

- `HelperProgram.ata` saving on Hadrian: **−170,771 CU per call (−59%)** — matches the 2026-05-11 Marcus measurement within sampling noise.
- `HelperProgram.pda` vs single `find_program_address`: **−67,083 CU (−36%)** — new datum.
- `SplTokenLib.transfer_checked + invoke` (legacy fallback, current `SPL_ERC20._transfer` path at `erc20spl.sol:269-291`) → `HelperProgram.transfer_spl`: **−372,059 to −394,493 CU per transfer (−67% to −71%)**. This is the highest-leverage open migration in this repo. See `2026-05-14-rome-primitive-cu-baseline.md` §"Strategic recommendation" for full priority order.

When writing new wrappers or adapters, prefer the `HelperProgram` selectors (single dispatch, signed by caller's `external_auth` PDA) over hand-rolled `0xFF…08` invoke + `0xFF…07` two-hop derivation.

### Contract Layers

- **`contracts/cpi/`** — Cardo CPI Foundation (library + templates). Shared Solidity helpers every Cardo app adapter builds on top of: `AccountMetaBuilder`, `AnchorInstruction`, `Cpi`, `PdaDeriver` (single PDA via `0xFF…07`), `PdasBatch` (multi-PDA via `0xFF…08` selector `0x944336f8` — use when deriving 2+ PDAs against the same Solana program), `SolanaConstants`, `UserPda`, `CostEstimate`, `CostEstimator`, `ICostView`, and the Pillar B cost-transparency trio. Also ships `templates/CpiAdapterBase.sol` (Ownable+Pausable+ReentrancyGuard+backend pointer scaffold) and `templates/CpiProgramWrapper.sol` (prose scaffold for golden-vector wrappers). See `contracts/cpi/README.md` for the adapter authoring guide, the three-layer pattern, and the `tx.origin`/`msg.sender` rule. Canonical spec: `rome-specs/active/technical/cardo-foundation.md`.
- **`contracts/spl_token/`** — Low-level SPL token and associated token account libraries (`SplTokenLib`, `AssociatedSplTokenLib`). These use `CpiProgram.account_info()` to deserialize on-chain Solana account data (Borsh-encoded) from within Solidity.
- **`contracts/erc20spl/`** — `SPL_ERC20` wraps an SPL mint as an ERC20 token with deposit/withdraw. `ERC20SPLFactory` deploys these wrappers. Uses OpenZeppelin IERC20. Generic outbound-bridge surface (`bridgeOutToSolana`, `ensureRecipientAta`) lets any deployed wrapper serve as a Rome → Solana SPL bridge — consumed by **rome-ui's `useOutboundSplBridge` hook** (see Cross-repo dependencies below). **Event emission:** `SPL_ERC20` emits standard `IERC20.Transfer` and `IERC20.Approval` events on all mutating paths (`_transfer`, `approve`, `mint_to`) — added in #83. Events fire after the underlying SPL CPI succeeds. **Auto-ATA:** `_transfer` and `mint_to` auto-create the recipient's ATA via `ensure_token_account` if it doesn't exist (#63), matching Phantom/Solana wallet UX — sender pays ~0.002 SOL rent. **Factory event:** `ERC20SPLFactory._register_contract` emits `TokenCreated` on every wrapper registration (#85), enabling rome-ui's backend token-discovery indexer. **`ERC20Users.ensure_user` is mapping-only** — it registers the EVM address in the wrapper's `users` mapping but does NOT pre-fund the unified PDA. PDA bootstrap happens explicitly via `SimpleActivator` (see `contracts/activation/`). **Post-consolidation (2026-05-12):** `getAta` / `balanceOf` / `_transfer` / `ensure_token_account` derive ATAs through `HelperProgram.ata(user, mint_id)` (PR #138 / #141); `transfer` + `transferFrom` route through `HelperProgram.transfer_spl(...)` (the 4-arg delegate variant for `from != msg.sender`, PR #143) — the prior `CpiProgram.spl_transfer_checked_v1` + `derive_user_ata` shortcuts at `0xff..08` no longer exist.
- **`contracts/activation/`** — `SimpleActivator` is the user-paid first-time account-bootstrap entry point. Split into **three** `payable` functions because each ATA-create + activator-PDA-topup CPI pair consumes ~950k CU on Solana, and bundling two ATA creates in one tx (~1.65M CU emulated) exceeds the 1.4M-CU per-tx cap. **Step 1 — `activate()`** funds the user's unified PDA at the rent-exempt floor (890,880 lamports) and registers the EVM address in the `ERC20Users` mapping so wrapper writes (`transfer` / `approve` / `transferFrom`) and DEX swaps resolve `users.get_user(msg.sender)` correctly. **Step 2 — `createWusdcAta()`** tops up the activator's PDA + creates the user's WUSDC ATA. **Step 3 — `createWsolAta()`** same pattern for WSOL ATA. All three idempotent — re-running each one is a no-op on Solana. The UI fires the three txs sequentially on a single click. Sybil resistance: user pays all calls themselves (default `activationCost` = 1 USDC, `tokenAccountsCost` = 0.5 USDC × 2 = 2 USDC total); zero operator subsidy. Replaces the earlier `PdaActivator` (single-tx Meteora swap path) which exceeded CU budget on chains with the post-clean-slate wrapper stack.
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
- **`contracts/examples/helper.sol`** — `helper_example` (Valentin's reference) demonstrates every `IHelperProgram` selector + the new `IWithdraw.withdraw_to_ata` leg via the canonical `address(HelperProgram).delegatecall(abi.encodeWithSignature(...))` pattern. Read this first when you need to invoke a HelperProgram method from a new contract.

### Cross-repo navigation — downstream agents

If you're working on...

| Goal | Use |
|---|---|
| Direct Solidity contract usage | Import from `contracts/interface.sol` (this repo) |
| Per-helper example code | `contracts/examples/helper.sol` — demonstrates every `IHelperProgram` + `IWithdraw` method via the delegatecall pattern |
| Cardo CPI Foundation | `contracts/cpi/` — `CpiAdapterBase`, `UserPda`, `PdaDeriver`, `PdasBatch`, `AnchorInstruction`, `AccountMetaBuilder`, cost-view trio |
| Multi-PDA derivation (2+ PDAs against the same Solana program) | `contracts/cpi/PdasBatch.sol` — wraps the `pdas_batch_derive` selector (`0xFF…08` / `0x944336f8`). Worked example: `contracts/examples/pdas_batch.sol`. Use this over N×`PdaDeriver.derive` whenever you derive ≥2 PDAs back-to-back against the same program. |
| Upstream precompile primitives (canonical) | [`rome-evm-private/CLAUDE.md`](../rome-evm-private/CLAUDE.md) — Rust dispatch + selector hex; treat as source of truth when adding methods |
| Bridge contracts | `contracts/bridge/RomeBridgeInbound.sol` + `RomeBridgeWithdraw.sol` + `contracts/bridge/README.md` |
| Activator | `contracts/activation/SimpleActivator.sol` (3-tx user-paid bootstrap) |
| ABI JSON for non-Solidity consumers | `npx hardhat compile` → `artifacts/contracts/interface.sol/*.json` |
| Token nomenclature (wUSDC vs USDC, lowercase `w`) | This file, §"Token nomenclature" |
| Cross-repo dependency map (rome-ui consumers) | This file, §"Cross-repo dependencies — rome-ui" |

### Contributor checklist — when adding a new helper to `interface.sol`

When extending `IHelperProgram` / `ICrossProgramInvocation` / `IWithdraw` / `ISystemProgram`:

1. **Mirror the upstream signature.** Declare the function in the appropriate Solidity interface using the canonical ABI signature.
2. **Verify the selector via `cast keccak`.** Compute `keccak256(signature)[0:4]` and confirm it matches the `pub const FOO_SELECTOR: &[u8] = &[…];` constant in `rome-evm-private/program/src/non_evm/<helper|cpi|withdraw>.rs`. Don't trust inline comments — re-derive.
3. **Add a worked example to `contracts/examples/helper.sol`.** Use the `address(HelperProgram).delegatecall(abi.encodeWithSignature(...))` pattern; show how arguments are encoded and how reverts are surfaced.
4. **Update the "Cross-repo dependencies — rome-ui" table** below with the new method and its downstream consumers (if any are wired in yet — leave a `TBD` if not).
5. **Run `npx hardhat compile`** to confirm consumers (`erc20spl`, `bridge/*`, `cpi/UserPda`, activator, oracle, meteora) still type-check against the updated interface.
6. **CHANGELOG.md entry** — a user-visible interface change always warrants one.

### Key Patterns

- Solana pubkeys are `bytes32` throughout; EVM addresses map to Solana PDAs via `RomeEVMAccount.pda(address)`.
- Cross-program invocation uses `ICrossProgramInvocation.invoke()` / `invoke_signed()` with Solana-style `AccountMeta` arrays.
- Borsh deserialization (`BorshLib`) decodes raw Solana account data returned by `CpiProgram.account_info()`.
- Deployment metadata is stored in `deployments/<network>.json` and consumed by tests via `scripts/lib/deployments.ts`. Local deployment artifacts (`deployments/local.json`, cached account data) are gitignored.
- Oracle adapters use EIP-1167 minimal proxy (clone) pattern — one implementation contract per oracle type, thin clones per feed. Factory validates Solana account ownership before deploying.
- Parser offsets are validated against live Solana accounts using `scripts/oracle/validate-*-offsets.ts` scripts. Always re-validate before redeployment.
- Oracle test harnesses (`contracts/oracle/test/`) expose internal parser functions for unit testing. Parser tests use mock account data (`tests/oracle/helpers/`).
- **UserPda library** (`contracts/cpi/UserPda.sol`) provides the canonical two-hop EVM-addr → AUTHORITY_PDA → ATA-of-PDA derivation. Use `UserPda.ata(account, mint_id)` and `UserPda.ataForKey(pubkey, mint_id)` instead of inlining the pattern (#82).
- **Internal overload trap:** when a contract has both an external multi-arg overload and an internal 3-arg overload (e.g. `invoke_swap`), call the internal one **without** `this.`. `this.foo()` forces an external call, which resolves to the external overload and fails to compile. Observed on `DAMMv1Pool.invoke_swap` (#23).

### Deployments

Deployment metadata is tracked in `deployments/{network}.json`, written by the Hardhat scripts on each `npx hardhat run`. The local stack file `local.json` is generated by `scripts/setup-local.ts` and should not be committed (regenerated per local stack restart). Per-chain devnet receipts are committed alongside their hardhat network entry.

**Current devnet deployments:** none. All 2026-04 → 2026-05 devnet chains (rome, subura, esquiline, cassius, cassius-test, monti_spl, maximus) were retired as part of the clean-slate transition. Their per-chain hardhat network entries + `deployments/<network>.json` artifacts were removed alongside the registry directory cleanup; CHANGELOG.md preserves the deploy history for archival reads. New chains add themselves back via `/bring-up-chain` Row 6 (`/deploy-solidity`).

### Networks

- `local` — local Rome-EVM node at `http://localhost:9090` (key: `LOCAL_PRIVATE_KEY`)
- `sepolia` — Ethereum Sepolia testnet (key: `SEPOLIA_PRIVATE_KEY`)
- `hardhatMainnet` — Hardhat EDR simulated L1 network (used for oracle parser unit tests)
- `hardhatOp` — Hardhat EDR simulated OP Stack network
- Per-chain Rome networks (`<chain>: { chainId, url, accounts: [<CHAIN>_PRIVATE_KEY] }`) are added when chains are brought up via `/bring-up-chain`.

**Decommissioned (removed from hardhat config in 2026-05):** `maximus` (121215, #90), `subura` (121222), `esquiline` (121225), `cassius` (121228), `cassius-test` (121298), `monti_spl` (legacy subura-proxy alias). See CHANGELOG.md for per-chain deploy history.

### Solidity Version

Target: `0.8.28`. Production profile enables optimizer with 200 runs.

## Agent Execution Guide

- All contracts consume precompile interfaces from `rome-solidity-sdk` (../rome-solidity-sdk/).
- After modifying precompile addresses or ABIs, verify consumers compile: `npx hardhat compile`.
- Test against local Rome-EVM node first: `npx hardhat test --network local`.
- Test against devnet: `npx hardhat test --network <chain>`.
- Oracle Gateway V2 contracts depend on live Pyth/Switchboard feeds — test against a live Rome devnet chain for oracle-related changes.
- Never deploy contracts without running the full Hardhat test suite.
- ERC-20 SPL wrappers interact with Solana precompiles at fixed addresses — verify precompile addresses match rome-evm-private if changed. Note: SPL Token (0xFF...05) and Associated Token (0xFF...06) dedicated handlers were removed in the Mollusk refactor; these now route through Mollusk SVM/CPI.
- Bridge deploy scripts (`scripts/bridge/deploy.ts`) require `USDC_MINT` and `WETH_MINT` env vars — no longer hardcoded to Rome's mints (#86). Wrapper deploys are skipped when the corresponding mint env var is unset; chains without an Ethereum-origin bridge target get paymaster + ERC20Users only.
- After deploying `ERC20SPLFactory` on a new chain, run `scripts/bridge/bootstrap-bridged-wrappers.ts` to register canonical wrappers via `add_spl_token_no_metadata` so the rome-ui backend's `TokenCreated` indexer can discover them.
- Update `CHANGELOG.md` when a PR lands user-visible behaviour changes or changes the deployed contract ABIs.

## Change Impact Map

| If you change... | Also check/update... |
|-----------------|---------------------|
| Precompile interface addresses or selectors | `contracts/interface.sol` MUST match `rome-evm-private/program/src/non_evm/*.rs` dispatch tables; re-verify any new selector via `cast keccak`. Mirror in `rome-solidity-sdk/` interfaces. |
| `IHelperProgram` surface (`0xff..09`) | `contracts/erc20spl/erc20spl.sol` (4 ATA reads + `_transfer` + `ensure_token_account`), `contracts/cpi/UserPda.sol` (`.ata` delegates), `contracts/bridge/RomeBridgeWithdraw.sol` (3 ATA reads), `contracts/activation/SimpleActivator.sol`, `contracts/examples/helper.sol` (worked examples). |
| `IWithdraw.withdraw_to_pda` / `withdraw_to_ata` | rome-ui `src/features/portfolio/hooks/useWrapUnwrap.ts` (wrap leg). |
| Contract ABIs | `rome-ui/src/abis/*.json` + parseAbi() call sites, `tests/` Solidity test contracts, `CHANGELOG.md` |
| `SPL_ERC20.bridgeOutToSolana` / `ensureRecipientAta` / `balanceOf` | **rome-ui** `src/features/bridge/hooks/useOutboundSplBridge.ts`, `useBalances.ts`, `useRomeHoldings.ts`. ABI is parseAbi-encoded inline; no JSON to regenerate. |
| `ERC20SPLFactory.add_spl_token_no_metadata` / `TokenCreated` event | **rome-ui** backend's token-discovery indexer (watches `TokenCreated` to populate Redis token cache served at `/api/tokens`); `src/features/portfolio/hooks/useChainTokenBalances.ts` consumes the cache. `src/abis/ERC20SPLFactory.json` mirror only if the indexer's ABI parser uses it. |
| `SimpleActivator.activate` / `createWusdcAta` / `createWsolAta` / `isActivated` / `activationCost` / `tokenAccountsCost` | **rome-ui** `src/features/portfolio/components/ActivateAccountButton.tsx` (primary CTA replacement on Swap/Bridge/Liquidity until activated; fires three txs sequentially on one click), `src/features/portfolio/hooks/useIsPdaActivated.ts` (visibility gate). Inline parseAbi; `chain.contracts.simpleActivator` field wires the address. |
| `RomeBridgeWithdraw.burnUSDC` / `burnETH` / `approveBurnETH` | **rome-ui** `src/features/bridge/hooks/useOutboundCctpSend.ts`, `useOutboundWhSend.ts`. Inline parseAbi, no JSON regen. |
| `RomeBridgePaymaster` / `RomeBridgeInbound` | **Legacy** since 2026-04-26 inbound rewrite — superseded by `settle_inbound_bridge` on rome-evm-private. rome-ui keeps these in `chain.contracts` config for back-compat parsing only; no active call sites. |
| Oracle adapter interfaces | Consuming contracts in this repo that use the adapters |
| SPL token wrapper logic | `rome-uniswap-v2/` (uses SPL wrappers for trading pairs); `rome-ui/src/features/portfolio` (renders wrapper rows via `useRomeHoldings`) |
| Hardhat network config | `rome-solidity-sdk/` uses same network definitions |

## Cross-repo dependencies — rome-ui

rome-ui consumes a small, stable surface from this repo. Changes to that surface MUST be cross-checked before merging here, because rome-ui is squash-merged independently and a broken ABI would ship the next time rome-ui redeploys.

### Active surface (consumed every render / every transaction)

| Contract | Method / event | rome-ui consumer |
|---|---|---|
| `SPL_ERC20` | `bridgeOutToSolana(bytes32 recipient, uint256 value) → bool` | `src/features/bridge/hooks/useOutboundSplBridge.ts` (Rome → Solana outbound for any wrapper) |
| `SPL_ERC20` | `ensureRecipientAta(bytes32 recipient) → bytes32` | same hook (preflight before bridge tx — single CPI ATA-create paid by sender's unified user PDA) |
| `SPL_ERC20` | `balanceOf(address) → uint256` (now reads AUTHORITY_PDA's ATA, not `_accounts` map) | wagmi multicall, `useChainTokenBalances`, every Portfolio row |
| `SPL_ERC20` | `transfer` / `transferFrom` / `approve` / `symbol` / `decimals` (standard IERC20 + IERC20Metadata) | wagmi readContract, TokenList, swap/liquidity flows |
| `SPL_ERC20` | `Transfer(from, to, value)` / `Approval(owner, spender, value)` events (emitted since #83) | rome-via-enrich/holders.rs (filters by topic0), eth_getLogs consumers, block explorers |
| `ERC20SPLFactory` | `add_spl_token_no_metadata(bytes32 mint, string name, string symbol)` | indirect — backend indexer watches `TokenCreated` event to populate Redis token cache served at `/api/tokens` |
| `ERC20SPLFactory` | event `TokenCreated(address creator, bytes32 mint, address wrapper, string name, string symbol, uint64 nonce)` | backend token-discovery indexer + rome-ui's `useChainTokenBalances`. Note: event was declared since inception but only actually emitted since #85; wrappers deployed before that fix are invisible to the indexer. |
| `SimpleActivator` | `activate() external payable` (tx 1: PDA fund + ensure_user) | `src/features/portfolio/components/ActivateAccountButton.tsx` (first-time PDA activation; primary CTA replacement on Swap/Bridge/Liquidity until activated; fires this tx first, then `createWusdcAta` + `createWsolAta` on the same click) |
| `SimpleActivator` | `createWusdcAta() external payable` (tx 2: activator PDA topup + WUSDC ATA) | same component — fired sequentially after `activate()` |
| `SimpleActivator` | `createWsolAta() external payable` (tx 3: activator PDA topup + WSOL ATA) | same component — fired sequentially after `createWusdcAta()` |
| `SimpleActivator` | `isActivated(address user) → bool` / `activationCost() → uint256` / `tokenAccountsCost() → uint256` | `src/features/portfolio/hooks/useIsPdaActivated.ts` (visibility gate for the Activate CTA) and the activation cost displayed in the CTA copy |
| `RomeBridgeWithdraw` | `burnUSDC(uint256 amount, address ethereumRecipient)` | `src/features/bridge/hooks/useOutboundCctpSend.ts` (Rome → Sepolia CCTP outbound) |
| `RomeBridgeWithdraw` | `approveBurnETH(uint256)` + `burnETH(uint256, address)` (two-tx pattern, CU constraint) | `src/features/bridge/hooks/useOutboundWhSend.ts` (Rome → Sepolia Wormhole outbound) |
| `Withdraw` precompile (`0x42..16`) | `withdraw_to_ata(uint256 wei_)` — wrap leg, gas → wrapper ATA | `src/features/portfolio/hooks/useWrapUnwrap.ts` |
| `HelperProgram` precompile (`0xff..09`) | `deposit_from_ata(uint256 wei_)` — unwrap leg, wrapper ATA → gas | `src/features/portfolio/hooks/useWrapUnwrap.ts` |

### Legacy / not consumed

`RomeBridgePaymaster` and `RomeBridgeInbound` are kept in `chain.contracts` config for back-compat parsing of older chains.yaml files. The current inbound flow is `settle_inbound_bridge` on rome-evm-private (signed by `SOLANA_SETTLE_PAYER_KEY` after Circle/Wormhole `receiveMessage` confirms) — no Rome EVM tx involved. Don't expand these contracts; deprecate them.

### Behavioral contracts (not just ABI)

These are observable from the outside but not enforced by the type system. Breaking any silently breaks rome-ui:

- `bridgeOutToSolana` signs as `AUTHORITY_PDA` (`find_program_address([EXTERNAL_AUTHORITY, evmAddr])`), with **empty seeds** in the precompile `invoke_signed`. The source ATA = `getATA(AUTHORITY_PDA, mint)` — the canonical cross-chain location where bridged-in tokens live. rome-ui assumes the recipient ATA already exists; callers MUST run `ensureRecipientAta` first if uncertain (see `useOutboundSplBridge`).
- `ensureRecipientAta` is **idempotent** — returns the same ATA address whether it pre-existed or was created. rome-ui probes Solana directly first to skip the call when not needed.
- `balanceOf` reads `getATA(AUTHORITY_PDA, mint)`, NOT the `_accounts` mapping. Bridged-in users (Wormhole complete_transfer_wrapped, useNativeDepositSend) only have balance in the AUTHORITY_PDA's ATA; the legacy mapping path returned 0 for them.
- `SimpleActivator.activate()` + `SimpleActivator.createWusdcAta()` + `SimpleActivator.createWsolAta()` are the user-paid first-time bootstrap, split into **three** txs because each ATA-create + activator-PDA-topup CPI pair consumes ~950k CU on Solana, and bundling two ATA creates in one tx (~1.65M CU emulated) was rejected at the rome-sdk pre-flight as `TooManyComputeUnitsInAtomicTx`. Tx 1 funds the user's unified PDA at the rent-exempt floor (890,880 lamports) and registers in the `ERC20Users` mapping. Tx 2 tops up the activator's own PDA and creates the user's WUSDC ATA. Tx 3 same pattern for WSOL ATA. Each is `payable` and idempotent (activate refunds `msg.value` if PDA already has lamports; the ATA-create calls no-op via `create_payer` + `ensure_token_account` short-circuits when state is already met). Sybil resistance: user pays all calls themselves; no operator subsidy. The previously-distinct `PAYER_PDA` (salted at `[EXTERNAL_AUTHORITY, evmAddr, "PAYER"]`) collapsed into the unified PDA in rome-solidity 0acabea — the unified PDA now signs CPIs, owns ATAs, and holds rent funds for transient bridge accounts.
- `ERC20Users.ensure_user(address)` is mapping-only — registers the EVM address in the wrapper's `users` mapping; does NOT pre-fund the PDA. The first-call subsidy was removed alongside `ERC20SPLFactory.create_user` in the activator switchover. PDA bootstrap goes through `SimpleActivator.activate` exclusively.

### Deployment artifacts rome-ui reads

`deployments/<network>.json` writes addresses on each `npx hardhat run scripts/...` deploy. The mirror canonical copy lives in `rome-protocol/registry` under `chains/<id>-<slug>/contracts.json`. rome-ui consumes the registry at runtime; never hand-edit deployed addresses without updating both sides.

## Test Selection Guide

| What Changed | Tests to Run |
|-------------|-------------|
| Any contract | `npx hardhat test` (full suite) |
| Oracle contracts | `npx hardhat test` + `npx hardhat test --network <chain>` (verify live feeds) |
| Precompile wrappers | `npx hardhat test` + `tests/` opcode suite in integration repo |
| ERC-20 SPL wrappers | `npx hardhat test` + `tests/` EVM suite |
| Hardhat config only | `npx hardhat compile` (verify config is valid) |
