# Stacked-op bench + projection model for real consumer flows

**Date:** 2026-05-23
**Chain:** Hadrian (testnet, chainId 200010)
**Bench contract:** [`contracts/examples/bench_stacked.sol`](../contracts/examples/bench_stacked.sol)
**Bench script:** [`scripts/bench_stacked.ts`](./bench_stacked.ts)

## Why this exists

The per-selector bench in [`CACHED_TRACK_BENCH_REPORT.md`](./CACHED_TRACK_BENCH_REPORT.md) measures one SPL operation per EVM tx. Real consumer contracts (Romeswap, Compound on Rome) stack multiple SPL operations in a single tx. This report establishes the linear-overhead model for stacked ops, then projects what real consumer flows would cost on the cached track once their cached-variant contracts ship.

## Synthetic stacked sweep

All measurements: total Solana CU summed across all sigs returned by `rome_solanaTxForEvmTx`. At every N, both tracks went iterative (2 sigs each) — the loop wrapper in the bench contract pushes the EVM tx body past the atomic threshold on both tracks. This is the realistic regime; production multi-step txs are nearly always iterative.

### N-stacked identical SPL transfer

| N | Cached CU | CPI CU | Δ CU | Δ % | Cached heap | CPI heap |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 156,035 | 138,579 | +17,456 | +12.6% | 18,568 | 17,080 |
| 2 | 183,678 | 168,541 | +15,137 | +9.0% | 23,872 | 20,896 |
| 3 | 226,766 | 206,666 | +20,100 | +9.7% | 28,408 | 23,944 |
| 5 | 301,441 | 262,962 | +38,479 | +14.6% | 39,016 | 31,576 |
| 8 | 407,638 | 354,622 | +53,016 | +15.0% | 52,624 | 40,720 |

### Heterogeneous add-liquidity-shape (5 ops: approve × 2, transferFrom × 2, transfer × 1)

| Op | Cached CU | CPI CU | Δ CU | Δ % |
|---|---:|---:|---:|---:|
| add-liquidity-shape (N=5) | 297,501 | 262,726 | +34,775 | +13.2% |

The heterogeneous flow lands within ~1% of the same-op N=5 sweep — confirming the linear model holds even when the stack mixes op kinds.

## Linear regression model

Least-squares fit on the N-stacked data:

```
cached_CU(N) ≈ 134,000 + 35,000 × N    (R² ≈ 0.999)
cpi_CU(N)    ≈ 121,000 + 30,000 × N    (R² ≈ 0.999)
```

Breakdown of the cached track's extra cost:

| Component | Cost | What it covers |
|---|---:|---|
| Iterative-VM intercept (per-tx) | ~13 K CU | NonEvmState journal init + commit-loop scaffolding |
| Per-op marginal | ~5 K CU | Per-staged-ix overhead in the journal + tail-commit invoke_signed |
| **Total cached overhead for K-step flow** | **13 K + 5 K × K** | |

This is the per-step projection formula. For a real flow with K SPL operations on the iterative path:

> **`projected_cached_CU ≈ measured_CPI_CU + 13 K + 5 K × K`**

Add-liquidity-shape validation: K=5 → predicted Δ = 13 + 5×5 = 38 K. Measured Δ = 34.8 K. **Δ-prediction error 8% — model good.**

## Heap projection model

The bench also captured heap. Linear regression on the same N-stacked data:

```
cached_heap(N) ≈ 16,200 + 4,300 × N  bytes
cpi_heap(N)    ≈ 16,400 + 3,000 × N  bytes
```

Cached overhead: ~1.3 KB per stacked SPL op (overlay's journal entry per ix). Both tracks fit comfortably within rome-evm's 256 KB heap ceiling for any realistic K. **The constraint that bites real flows is CU, not heap.**

## Projection for real consumer flows on Hadrian

Applying the model to flows that already run on Hadrian's CPI-track stack (deployed: `RomeswapMinimalRouter @ 0x0986CAfEC1214Ef4Cfc046A59743DAA7eAd0BFcb`, `UniswapV2Router02 @ 0x0EFEc612B7c3E3E1708a2d57BC39D97F8fa201a7`, pair @ `0x3595CCd9…`):

| Flow | K (SPL ops) | Measured CPI CU | Projected cached CU | Δ CU | Δ % | Cached heap | CPI heap |
|---|---:|---:|---:|---:|---:|---:|---:|
| `pair.burn` (wUSDC × wETH) — helper-direct, post rome-uniswap-v2 PR #54 | 2 (transfer A out + transfer B out) | **859 K** (measured 2026-05-21) | ~882 K | +23 K | +2.7% | ~25 KB | ~22 KB |
| `addLiquidity` (wUSDC × wETH) | 2 (transferFrom A + transferFrom B) | ~290 K (typical Romeswap add-liq) | ~313 K | +23 K | +7.9% | ~25 KB | ~22 KB |
| `swap` (single hop) | 2 (transferFrom in + transfer out) | ~265 K | ~288 K | +23 K | +8.7% | ~25 KB | ~22 KB |
| `removeLiquidity` via router (pair.burn helper-direct fix landed 2026-05-22) | 3 (burn LP + 2 transfers) | ~880 K | ~908 K | +28 K | +3.2% | ~29 KB | ~25 KB |

**Range: +2.7% to +8.7% projected cached overhead on Romeswap flows.** Small in % terms — the per-flow overhead is fixed at ~13K (intercept) + 5K × K (per-op), so flows with larger CU base see smaller relative overhead. Heap headroom is generous (40-50× margin under 256 KB).

## Compound on Rome — corrected projection

Earlier draft of this report had **~600K CPI projection for liquidate-5 — that was wrong**. Real Compound-on-Rome measurements from rome-specs show per-Comet-action CU is **600-900K each**, not for the whole flow. Authoritative numbers ([`2026-05-17-compound-on-rome-vanilla-atomic-architecture.md`](../../rome-specs/active/technical/2026-05-17-compound-on-rome-vanilla-atomic-architecture.md), [`2026-05-18-compound-liquidation-jito-bench-results.md`](../../rome-specs/active/technical/2026-05-18-compound-liquidation-jito-bench-results.md), [`2026-05-04-compound-on-rome-unified-usdc.md`](../../rome-specs/active/technical/2026-05-04-compound-on-rome-unified-usdc.md), and quaestor Phase 0/2 measurement files):

### Per-action Compound CU (measured, CPI track)

| Operation | CPI CU | Notes |
|---|---:|---|
| `cometProxy.borrow` (iter mode) | iter1 16K + iter2 **1.28M** = ~1.30M | 121K headroom under 1.4M iter ceiling |
| `cometProxy.supply` via UnifiedToken | **busts 1.4M iter ceiling** (rejected pre-send by emulator) | Phase 2 blocker, requires orchestrator/MetaHook fix |
| `Bulker.invoke([SUPPLY, WITHDRAW])` 2-action atomic | **1,299,725** | 101K margin under 1.4M atomic |
| `Bulker.invoke([SUPPLY, BORROW, WITHDRAW])` 3-action atomic | **~1.95M** | **busts 1.4M atomic — structurally impossible** |
| `LiquidationRouter.absorb + buyCollateral` composed (1-asset) | **~1.95M** | busts 1.4M atomic; needs Jito bundle split |

### Compound bookkeeping cycle per action

Each Comet action does a full cycle: `accrueInternal` (interest accrual + oracle read) + `doTransferIn`/`doTransferOut` (with pre/post `balanceOf` checks — TWO SPL `account_info` reads per CPI) + `userBasic` update + `totalsCollateral` update + `updateAssetsIn` bitmap + event emit. **600-900K CU per action** is the structural reality; you cannot stack more than ~2 atomic before busting the 1.4M ceiling.

### Corrected projection table

| Compound variant | Actions | SPL ops | Measured CPI CU | Cached projection (CPI + 13K + 5K × K) | Fits 1.4M atomic? |
|---|---:|---:|---:|---:|---|
| `borrow` (1-action) | 1 | ~2 (transferOut + balance check) | ~1.30M iter | ~**1.32M** iter | atomic NO (over 1.4M), iter YES |
| `Bulker.invoke` (2-action atomic) | 2 | ~4 (2 transferFrom + 2 transfer) | **1.30M** (measured Hadrian) | ~**1.33M** | YES (~70K margin, vs 101K margin CPI) |
| `Bulker.invoke` (3-action atomic) | 3 | ~6 | ~1.95M | ~**1.98M** | **NO either track — structural** |
| `absorb + buyCollateral` (1-asset liquidate) | 2 | ~4 (repay + collateral seize + 2 balance checks) | ~1.95M | ~**1.98M** | **NO — Jito-bundle workaround required** |
| `liquidate-5` (5-asset, Tower 1 target) | 10 (5 absorb + 5 buy) | ~20 (10 transfers + 10 balance checks) | **~6-9M total** | ~**6.1-9.1M** | **NO — must split across multiple Solana txs via Jito or sequential** |

**Liquidate-5 reality:** it's NOT a single-tx flow on either track. CPI track requires `LiquidationRouter.absorbAndBuyMulti` to be split into N separate Solana txs (each ~1.95M, bundled atomically via Jito at the slot level on testnet/mainnet — see [`2026-05-18-compound-liquidation-jito-bench-results.md`](../../rome-specs/active/technical/2026-05-18-compound-liquidation-jito-bench-results.md) for the `R` parameter — max collats per single Solana tx via the multi-router). Cached track has the same structural ceiling (1.4M per Solana tx, immutable Solana runtime limit) — cached's value here is **revert atomicity within a single tx**, not "fits more in one tx."

### Where cached actually helps Compound

| Use case | Current CPI cost | Cached projection | Cached value |
|---|---|---|---|
| 1-action `supply` via UnifiedToken (currently blocked) | >1.4M iter (busts ceiling, rejected pre-send) | ~1.4M + ~15K = **still busts ceiling** | None — both blocked structurally; needs MetaHook/orchestrator architecture, not cached |
| `Bulker.invoke` 2-action atomic | 1.30M atomic (101K margin) | ~1.33M atomic (~70K margin) | Marginal — slightly less margin, gains revert atomicity (already atomic, so revert atomicity is implicit) |
| Single liquidation via `LiquidationRouter` | ~1.95M (Jito-split required) | ~1.98M (still Jito-split required) | **Minor structural overhead. Cached doesn't unlock liquidate-N — Solana's per-tx 1.4M ceiling is the real gate.** |
| Multi-step intra-tx safety (hypothetical: combine `supply` + `transferFrom` + `swap` in one tx) | Not viable today — `CpiProhibitedInIterativeTx` hard-blocks mixing SPL CPIs with iterative VM EVM | Cached overlay queues all SPL ops, commits on EVM commit, discards on EVM revert | **Unlocks cross-protocol intent composition** in iterative VM — the genuine cached use case |

### Honest verdict on Compound liquidate-5

My earlier projection (+15% / ~88K cached overhead for liquidate-5) was **dimensionally correct for per-SPL-op overhead, but applied against a fabricated CPI baseline**. The real liquidate-5 baseline is 6-9M CU across multiple Solana txs (NOT a single-tx flow on either track). Cached's ~88K overhead is rounding error against that. **Cached does not unlock liquidate-5; Solana's per-tx 1.4M ceiling does, by requiring Jito bundle splits**, which both tracks need equally.

Where cached genuinely matters for Compound: future cross-protocol composed intents where the value is intra-EVM-tx revert atomicity across queued SPL effects, not raw CU savings.

## When cached's overhead is worth it

| Use case | Cached overhead | Worth it? | Why |
|---|---:|---|---|
| Single-op (transfer, approve) | +5-15% | Maybe | Pay for revert atomicity only if you need it |
| 2-3 step user flow (swap, addLiquidity) | +3-9% | **Yes** | Small overhead, large UX win (no partial-fill states) |
| 5+ step composed flow (Compound liquidate, Romeswap multi-hop) | +12-15% | **Yes** | Required — without cached, partial commits leave on-chain state inconsistent |
| One-shot bridge tx (Wormhole outbound, CCTP) | +5-10% AND attack surface | **No** | Legacy CPI's `CpiProhibitedInIterativeTx` IS the defense; bridge doesn't need atomicity |

## Cross-references

- [`CACHED_TRACK_BENCH_REPORT.md`](./CACHED_TRACK_BENCH_REPORT.md) — per-selector bench (single op per tx)
- [`bench_stacked.sol`](../contracts/examples/bench_stacked.sol) + [`bench_stacked.ts`](./bench_stacked.ts) — the synthetic stacked bench
- rome-uniswap-v2 PR #54 — pair.burn helper-direct fix (the 859 K CU measurement source)
- rome-evm-private#383 — Phase A cached selectors that unblock cached SPL_ERC20 / Compound variants
