# rome-solidity — architecture & contract reference

The complete map of what this repo exposes, **why each piece exists**, and **where it's used** across the Rome ecosystem. Ordered by importance — the primitives everything else builds on come first.

> **Mental model.** Rome runs an EVM *inside* a Solana program. A Solidity contract reaches the surrounding Solana runtime only through **precompiles** at fixed addresses (`0xff…`, `0x42…16`). `contracts/interface.sol` is the ABI for those precompiles; everything else in this repo is a Solidity layer built on top of them — the CPI toolkit, the SPL↔ERC-20 wrappers, the bridge egress, and the oracle adapters.

**The layers, high to low:**

```
examples/                        worked references
  ├── erc20spl/  bridge/  oracle/   capabilities you consume
  │        └── cpi/                    the builder-facing CPI toolkit
  │              └── interface.sol       precompile ABIs (the ground floor)
  └── spl_token/ system_program/ rome_evm_account  low-level account/token primitives
```

---

## 1. Precompile interfaces — `contracts/interface.sol`

The ABI bindings to Rome's non-EVM precompiles. Everything in the repo ultimately calls these. Two families:

- **CPI / utility family** — `ISystemProgram` (`0xff…07`, reads), `ICrossProgramInvocation` (`0xff…08`, the raw CPI primitive), `IHelperProgram` (`0xff…09`, composite one-shots), `IWithdraw` (`0x42…16`, legacy non-revertable gas exit).
- **Cached family** — `ISystemCached` (`0xff…04`), `ISplCached` (`0xff…05`), `IAssociatedSplCached` (`0xff…06`), `IWithdrawCached` (`0xff…0b`). These route the Solana side effect through the Rome-EVM **journal**, so it is **atomically revertable** alongside EVM state and is **iterative-VM compatible** (multi-step txs).

| Interface | Addr | What | Why |
|---|---|---|---|
| `ISystemProgram` | `0xff…07` | PDA derivation, base58 codec, chain-identity getters (view/pure) | EVM code must compute Solana addresses + read host identity without leaving the EVM |
| `ICrossProgramInvocation` | `0xff…08` | `invoke` / `invoke_signed` + account-read & batch-PDA shortcuts | *The* primitive that makes "EVM inside Solana" composable — call any Solana program |
| `IHelperProgram` | `0xff…09` | ATA/PDA create, SPL transfer/approve/mint, gas↔lamports, collapsed reads | Folds multi-step CPI compositions into single dispatches to save CU |
| `IWithdraw` | `0x42…16` | Move native gas value out of the EVM to Solana (owner/PDA/ATA) | Users must exit EVM gas balances back to Solana; legacy non-revertable path |
| `ISystemCached` | `0xff…04` | Journaled System-program ops (create_pda/allocate/transfer) | Account ops that revert atomically with the EVM tx |
| `ISplCached` | `0xff…05` | Journaled SPL Token ops (ERC-20-shaped transfer/approve/mint + reads) | Revertable SPL ops; exposes ERC-20 selectors so SPL behaves like ERC-20 |
| `IAssociatedSplCached` | `0xff…06` | Journaled Associated-Token-Account creation | Create ATAs on the revertable path |
| `IWithdrawCached` | `0xff…0b` | Journaled gas exit + `deposit` inverse (SPL in → native gas) | Revertable gas wrap/unwrap |

**Where used:** `rome-sdk-ts` mirrors the whole surface in TypeScript (`src/abis.ts`, `src/selectors.ts`, `src/addresses.ts`); `compound-on-rome-comet` **vendors** the bindings (`contracts/lib/RomePrecompiles.sol` — "copied from rome-solidity"); `cardo` and `appia` mirror the CPI precompile ABI in TS (`lib/cpi-precompile.ts`).

---

## 2. CPI toolkit — `contracts/cpi/`

Builder-facing Solidity libraries layered over the CPI precompile — the ergonomic way to call a Solana program from Solidity. Start here: **`contracts/cpi/README.md`** is the "CPI Foundation" guide (three-layer adapter pattern, the `tx.origin` ban, `invoke` vs `invoke_signed`, cost-quote checklist, CU/account budgets).

| Contract | What | Key surface |
|---|---|---|
| `Cpi` | Canonical thin wrapper over the CPI precompile — one call site for every EVM→Solana CPI | `invoke` / `invokeSigned` / `accountInfo` |
| `AccountMetaBuilder` | Fluent builder for `AccountMeta[]` arrays (signer/writable/readonly) | `alloc` / `signer` / `writable` / `buildChecked` |
| `AnchorInstruction` | Anchor call-data encoding (8-byte discriminator + Borsh LE + `Option<T>`) | `discriminator(name)` / `withDisc` / `u64le` / `optionSome` |
| `AccountReader` | Typed wrappers over the account-read shortcut selectors — **reads, not CPIs** (no signing, no side effect) | `lamportsOf` / `readU64At` / `readBytesAt` |
| `PdaDeriver` | Single-PDA `find_program_address` + typed seed builders | `derive` / `seedBytes` / `makeSeeds` |
| `PdasBatch` | Derive N PDAs against one program in a single syscall (~50–80K CU saved per PDA) | `derive(seedGroups, programId)` / `pair` / `triplet` |
| `UserPda` | EVM address → Solana user PDA + ATA, always via an explicit `address` (never `tx.origin`) | `pda(address)` / `ata(address, mint)` / `atas` |
| `EnsureAta` | Idempotently create a user's ATA before a downstream CPI needs it | `ensure(user, mint)` |
| `SolanaConstants` | Canonical Solana sysvar/program pubkeys as `bytes32` | `SPL_TOKEN_PROGRAM` / `SYSVAR_RENT` / … |
| `CostEstimate` / `CostEstimator` / `ICostView` | Uniform pre-sign USD cost-quote shape + helpers (rent math, existence checks, oracle-priced) | `quoteCost(user, inputs) → CostEstimate` |
| `CpiError` | Shared error selectors for adapters | `AmountTooLarge` / `SignerMismatch` / `InvalidAccountCount` |
| `templates/CpiAdapterBase` | Abstract adapter base — Ownable + Pausable + ReentrancyGuard + rotatable backend | `setBackend` / `pause` / `withdrawERC20` |
| `templates/CpiProgramWrapper` | Prose scaffold for per-adapter golden-vector test wrappers (non-functional) | — |

**Why it exists:** replaces ~12 inline precompile calls per adapter with one legible, CU-aware, phishing-safe (`address`-explicit) library layer. **Where used:** `cardo` (primary — drives Jupiter/Meteora/Marinade/Streamflow via CPI), `appia`, `compound-on-rome-comet` (vendored precompiles), and `rome-dex`'s EVM-lane router. Public apps typically mirror the CPI precompile ABI in TypeScript rather than importing the Solidity libraries directly.

---

## 3. SPL ↔ ERC-20 wrappers — `contracts/erc20spl/`

**Any SPL token is an ERC-20 on Rome** through these wrappers — same account, no bridge hop. There are **two wrapper tracks** exposing the identical `IERC20 + IERC20Metadata` surface; they differ only in which precompile family their mutations dispatch through. **This choice is a hard, per-contract rule — a contract uses one track, never both.**

### The two paths — which to use

| | **Cached** — `SPL_ERC20_cached` | **CPI-based** — `SPL_ERC20` |
|---|---|---|
| Dispatches through | cached precompiles `SplCached 0xff…05` / `AssociatedSplCached 0xff…06` | `HelperProgram 0xff…09` → real CPI Invoke |
| Side effect | journaled → **commits at end-of-tx, unwinds on EVM revert** | **hits Solana at call time** — not revertable if the EVM tx later reverts |
| Iterative (multi-step) VM | ✅ compatible | ✗ hits `CpiProhibitedInIterativeTx` after the first transfer |
| CU cost | cheaper (2–10%) | higher |
| **Use it for** | **the default** — all standard ERC-20 flows, anything composing in the iterative VM (multi-hop DEX, bulkers), anything needing EVM-revert atomicity | operations the cached track can't do — pushing SPL out to an **arbitrary raw Solana wallet** (`bridgeOutToSolana` / `ensureRecipientAta`, which need the **permanently-CPI-only** `create_ata_for_key`) |

The factory deploys the **cached** wrapper for every token (`new SPL_ERC20_cached(...)`); the cached header states it *"replaces the CPI-based SPL_ERC20 on devnet."* Reach for the CPI wrapper only when you specifically need its Solana-wallet exit path.

| Contract | What | Key surface |
|---|---|---|
| `SPL_ERC20_cached` | Cached-track ERC-20 wrapper (default); no CPI Invoke, overlay-aware reads | `transfer`/`transferFrom`/`approve`/`mint_to` → `SplCached` |
| `SPL_ERC20` | CPI-track ERC-20 wrapper; can push SPL to a raw Solana wallet | `bridgeOutToSolana(bytes32,uint256)`, `transfer`/`approve` via `HelperProgram` |
| `ERC20Users` | Shared registry: EVM `address` → its `external_auth` Solana PDA | `ensure_user` / `get_user` |
| `ERC20SPLFactory` | Wrap existing SPL mints (with/without metadata) + mint brand-new SPL tokens; deploys the cached wrapper | `add_spl_token_with_metadata` / `add_spl_token_no_metadata` / `create_token_mint` |
| `cached_revert_demo` | Executable proof of the cached track's revert / iterative / one-track properties | (demos) |

**Where used:** the AMM & lending forks trade against the **cached** wrappers — Uniswap-style AMM forks, `rome-aave-v3` (reserves = wUSDC/wETH/wSOL cached), `compound-on-rome-comet` (collateral/base, wired by address); UIs `aerarium`, `cardo`, `rome-aave-v3-demo` read/transfer them; `ERC20SPLFactory` is deployed/reused by the AMM forks and `cardo`. The non-cached `SPL_ERC20` has no public app consumer by name — it's superseded by the cached track on devnet and retained for its CPI-only exit path.

---

## 4. Bridge — `contracts/bridge/`

The **on-chain half** of the Rome bridge — the *egress* surface for leaving Rome. (The off-chain orchestrator that fetches CCTP attestations / Wormhole VAAs and submits the destination leg is the separate **`rome-bridge-api`** repo.)

| Contract | What | Key surface |
|---|---|---|
| `RomeBridgeWithdraw` | The single outbound entrypoint — takes an SPL-wrapper token in on Rome and fires a Solana CPI (direct CALL, signed as the bridge's own Rome PDA — a delegatecall into a mutating precompile is refused) over one of five rails | see rails below |
| `RomeBridgeEvents` | Shared event schema the `rome-bridge-api` indexer watches to attribute each egress | `Withdrawn` / `WormholeBurn` / `BridgedOutToSolana` / … |
| `ICCTPV2` (`CCTPV2Lib`) | **The live CCTP encoder** — `deposit_for_burn` bytes + 19 account-metas for Circle CCTP **v2** | `encodeDepositForBurn` / `buildDepositForBurnAccounts` |
| `ICCTP` (`CCTPLib`) | Legacy CCTP **v1** encoder (retained reference; not imported by the live withdraw contract) | `encodeDepositForBurn` (v1, 18 metas) |
| `IWormholeTokenBridge` | Wormhole egress encoders — `transfer_wrapped` (tag 4) and `transfer_native` (tag 5) | `encodeTransferTokens` / `buildTransferWrappedAccounts` |

**The five egress rails** on `RomeBridgeWithdraw` (all permissionless; network config injected via constructor, so one bytecode works on any chain):
1. **CCTP (USDC)** — `burnUSDC(amount, recipient[, destinationDomain])` → CCTP **v2** `deposit_for_burn`. Per-call Circle domain (e.g. Monad = domain 15, v2-only).
2. **Wormhole ETH** — `burnETH`, single tx: pulls the caller's SPL into the bridge's own ATA, re-grants Wormhole's delegate there, and burns. Precondition (off-contract): the caller grants the bridge an SPL delegate once via `approve_spl(bridge, …)` sent directly to `0xff..09`.
3. **Generic Wormhole** — `burnToWormhole(assetWrapper, amount, recipient, targetChain)`, single tx, same pull-then-burn shape as `burnETH`, for any allowlisted wrapper/chain.
4. **Wormhole native** — `transferNativeToWormhole(...)` locks Solana-native mints (wSOL/LSTs) into per-mint custody instead of burning.
5. **Rome → Solana SPL** — `bridgeOutToSolana(recipient, amount, mint)` + `ensureRecipientAta(...)` (the generic SPL exit for any wrapper).

**Why it exists:** the trustless, user-signed on-chain path out of Rome; the user's single `external_auth` PDA is auto-signed by the rome-evm precompile (users pre-fund it via `SimpleActivator`). **Where used:** `rome-bridge-api` is the canonical consumer (builds egress txns for all five rails); `appia` (`src/egress.ts` — "deliver to my wallet" Wormhole egress), `cardo` (bridge-out flows), `rome-aave-v3-demo` (cross-chain funding UI).

> Note: `contracts/bridge/README.md` is Phase-1-era and lags the code (documents CCTP v1, omits v2/Monad + `burnToWormhole` + `transferNativeToWormhole` + the unified-PDA model). Trust `RomeBridgeWithdraw.sol`'s NatSpec and this document over it.

---

## 5. Oracle — `contracts/oracle/`

Solana price feeds (Pyth Pull, Switchboard V2) surfaced to EVM contracts through the **standard Chainlink `AggregatorV3Interface`** — so a Compound/Aave-style consumer reads them unmodified. Builder-facing home: **`rome-oracle-gateway`** (a pointer repo; the contracts live here). A deploy portal + a refresh keeper (run by Rome) deploy the adapter clones and keep the cached feeds fresh.

| Contract | What |
|---|---|
| `IAggregatorV3Interface` | The verbatim Chainlink interface every adapter implements — the common denominator |
| `IExtendedOracleAdapter` | `is IAggregatorV3Interface` + confidence/EMA/status/source reads |
| `PythPullAdapter` | **Direct** adapter — reads a Pyth `PriceUpdateV2` account off Solana on every read, normalizes to 8 decimals |
| `SwitchboardV3Adapter` | **Direct** adapter over Switchboard V2 (keeps "V3" name for ABI back-compat; `latestEMAData` reverts) |
| `CachedPythAdapter` | **Cached** Pyth adapter — `refresh()` does the ~509K-CU parse+SSTORE on a keeper tx; `latestRoundData()` is a cheap SLOAD |
| `CachedFeedAdapter` | **Cached** decorator over *any* `AggregatorV3` feed (Pyth/Switchboard/Chainlink) |
| `PythPullParser` / `SwitchboardParser` | Borsh decoders pinning the validated Solana account byte-layouts |
| `OracleAdapterFactory` | Deploys all four adapter kinds as EIP-1167 clones; validates the Solana account's owner-program; holds the pause kill-switch |
| `BatchReader` | Fans out reads/health over many feeds with per-feed `try/catch` isolation |
| `IAdapterFactory` / `IAdapterMetadata` | Pause-check callback + one-call self-description |
| `examples/MockChainlinkOracle` / `SampleLendingOracle` | A settable mock feed + a reference consumer proving the Chainlink abstraction holds |

**Why cached vs direct:** a multi-collateral borrow that reads every feed atomically blows the ~1.4M-CU cap on the ~509K-CU-per-read Pyth parse; the cached adapters move the parse onto the keeper's own tx (trust unchanged — they snapshot the *verified* on-chain account). **Where used:** `rome-aave-v3` (AaveOracle reads adapters via `IAggregatorV3Interface`), `compound-on-rome-comet` (Chainlink-compatible feeds), `rome-dex` + `cardo` + `aerarium` (live price reads); the oracle portal + keeper deploy clones and refresh the cached feeds. Adapter addresses live in the registry (`chains/<id>/oracle.json`).

---

## 6. Account & token primitives

Low-level building blocks the layers above rest on.

| Contract | What | Why |
|---|---|---|
| `rome_evm_account.sol` (`RomeEVMAccount`) | Derives a user's unified `external_auth` PDA (+ salted variants); computes SPL rent minimums | Every wrapper/factory/bridge resolves "the Solana account that acts for this EVM address" here |
| `activation/SimpleActivator.sol` | One-tx **user-paid** bootstrap: `activate{value}()` creates+funds the caller's PDA + wUSDC/wSOL ATAs + registers the user (~234K CU) | A fresh EVM address becomes fully transactable in one MetaMask popup, Sybil-resistant |
| `wrap/WrappedGasFacade.sol` | WETH9-shaped `deposit()`/`withdraw()` over the native-gas-wrapper precompiles | Explorers/indexers see gas wrap/unwrap as ordinary WETH9 events. Cached-track only |
| `spl_token/spl_token.sol` (`SplTokenLib`) | Pure Borsh decoder for the SPL `Mint` (82-byte) + token-account `amount` layouts | Wrappers need typed decimals/supply/amount out of raw Solana bytes |
| `spl_token/associated_spl_token.sol` | Builds the Associated-Token `Create`/`CreateIdempotent` ix + derives the ATA address | The deterministic ATA-address primitive |
| `system_program/system_program.sol` | Pure builder for the Solana System `transfer` (lamports) instruction | Lamport moves (e.g. funding a PDA payer) need a correctly LE-encoded ix |
| `convert.sol` (`Convert`) | LE/Borsh readers + writers + revert-reason decoder | Solana is LE/Borsh, the EVM is big-endian — every parse/serialize goes through here |

**Where used:** internal to the wrappers/bridge/factory; `RomeEVMAccount.pda` derivation is mirrored by `rome-sdk-ts` (`src/pda.ts`); `SimpleActivator.activate` is the funding step every dual-lane app calls before a user's first PDA-signed action.

---

## 7. Examples — `contracts/examples/`

Worked, compilable references for the toolkit:

| File | Demonstrates |
|---|---|
| `helper.sol` | `IHelperProgram` primitives (ATA/PDA create, SPL transfer, gas↔lamports) |
| `cached.sol` | The cached-precompile track end-to-end |
| `bench_cached.sol` / `bench_stacked.sol` | CU benchmarking of cached vs stacked call paths |
| `mixed.sol` | Mixing EVM and non-EVM calls under the dispatch rule |
| `cu.sol` (+ `cu_yul.yul`) | CU-measurement harness |
| `pdas_batch.sol` | Batch PDA derivation (`PdasBatch`) |
| `bridge.sol` | A bridge-interaction example |
| `orra.sol` | Sub-user-key / trade-key derivation pattern |

---

## Import paths

```solidity
// Precompile interfaces + bound singletons
import {ISystemProgram, ICrossProgramInvocation, IHelperProgram, IWithdraw,
        CpiProgram, HelperProgram, SplCached, AssociatedSplCached}
    from "@rome-protocol/rome-solidity/contracts/interface.sol";

// SPL ↔ ERC-20
import {SPL_ERC20_cached} from "@rome-protocol/rome-solidity/contracts/erc20spl/erc20spl_cached.sol";
import {ERC20SPLFactory}  from "@rome-protocol/rome-solidity/contracts/erc20spl/erc20spl_factory.sol";

// Account model
import {RomeEVMAccount} from "@rome-protocol/rome-solidity/contracts/rome_evm_account.sol";

// Oracle (Chainlink-compatible)
import {IAggregatorV3Interface} from "@rome-protocol/rome-solidity/contracts/oracle/IAggregatorV3Interface.sol";
```

npm publish is pending — consume via a github-pinned git dependency or by copying files (the CPI-precompile ABIs are also mirrored in `@rome-protocol/sdk`).
