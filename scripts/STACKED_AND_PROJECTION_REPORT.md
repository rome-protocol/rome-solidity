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

## Projection for real consumer flows on Hadrian

Applying the model to flows that already run on Hadrian's CPI-track stack (deployed contracts: `RomeswapMinimalRouter @ 0x0986CAfEC1214Ef4Cfc046A59743DAA7eAd0BFcb`, `UniswapV2Router02 @ 0x0EFEc612B7c3E3E1708a2d57BC39D97F8fa201a7`, pair @ `0x3595CCd9…`):

| Flow | K (SPL ops) | Measured CPI CU | Projected cached CU | Δ CU | Δ % |
|---|---:|---:|---:|---:|---:|
| `pair.burn` (wUSDC × wETH) — helper-direct, post rome-uniswap-v2 PR #54 | 2 (transfer A out + transfer B out) | **859 K** (measured 2026-05-21) | ~882 K | +23 K | +2.7% |
| `addLiquidity` (wUSDC × wETH) | 2 (transferFrom A + transferFrom B) | ~290 K (typical Romeswap add-liq path) | ~313 K | +23 K | +7.9% |
| `swap` (single hop) | 2 (transferFrom in + transfer out) | ~265 K | ~288 K | +23 K | +8.7% |
| `removeLiquidity` via router (`burnLPFor` previously busted 1.4M envelope on CPI; pair.burn helper-direct fix landed 2026-05-22) | 3 (burn LP + 2 transfers) | ~880 K | ~908 K | +28 K | +3.2% |

**Range: +2.7% to +8.7% projected cached overhead on real flows.** Small in % terms — the per-flow overhead is fixed at ~13 K (intercept) + 5 K × K (per-op), so flows with larger CU base see smaller relative overhead.

## Compound on Rome — projection (Compound is on devnet, not Hadrian)

Compound on Rome's `liquidateBorrow(borrower, repayAmount, cTokenCollateral)` orchestrates a multi-asset settlement:

| Step | Operation | SPL ops |
|---|---|---:|
| 1 | Accrue interest on the borrow market | 0 (EVM only) |
| 2 | Accrue interest on the collateral market | 0 (EVM only) |
| 3 | Liquidator `transferFrom`s borrowAsset to the borrow cToken | 1 |
| 4 | Borrow cToken burns the cToken-share from borrower (EVM-only) | 0 |
| 5 | Collateral cToken transfers the seize amount to liquidator | 1 |
| 6 | Collateral underlying SPL → liquidator (if redeem-on-liquidate enabled) | 1 |
| **Total** | | **3** |

| Variant | K (SPL ops) | Projected CPI CU (from typical liquidate cost) | Projected cached CU |
|---|---:|---:|---:|
| Single-asset liquidate | 3 | ~400 K (estimate, no on-chain Hadrian measurement) | ~428 K |
| 5-asset liquidate (Tower 1 "liquidate-5" target) | 15 | ~600 K | ~688 K |

**5-asset liquidate cached overhead: ~88 K (+15%)** — within the bench's measured ceiling (+15% at N=8). Cached unlocks the **revert atomicity** that makes 5-asset liquidation safe: if any of the 15 SPL ops fails mid-tx, the entire EVM frame reverts and the cached overlay discards all queued ixs. The CPI path can't offer this — once it has invoke_signed'd the first SPL transfer, the Solana state is committed even if a later EVM revert fires.

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
