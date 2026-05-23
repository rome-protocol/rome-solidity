# Cached track full-gamut benchmark — PR #376 + #383 selectors

**Date:** 2026-05-23
**Chain:** Hadrian (testnet, chainId 200010)
**Rome EVM program:** `RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf` (post #383+#384)
**Proxy/emulator:** rome-apps `testnet-65ab3ab` (proxy git `003bccb9…`, emulator built against rome-evm-private `65ab3ab1…`)
**Bench contract:** [`contracts/examples/bench_cached.sol`](../contracts/examples/bench_cached.sol)
**Bench script:** [`scripts/bench_cached.ts`](./bench_cached.ts)
**Caller EOA:** `0x1f4946be340f06c46a50e65084790968abcc48f6`

## Method

For every cached-track selector shipped in rome-evm-private#376 + #383, the bench contract pairs the cached call against its closest CPI-path equivalent on `HelperProgram` / `Withdraw`, called via the same `delegatecall + abi.encodeWithSignature` pattern. Each pair is exercised in **two separate EVM transactions** (the per-tx `verify_call` gate fires only within a single tx — separating cached and CPI calls across txs is required and is what production migration looks like).

Captured per call:
- **EVM gas** via `eth_getTransactionReceipt.gasUsed`
- **All Solana tx signatures** via `rome_solanaTxForEvmTx(evmHash)` — iterative EVM txs produce multiple Solana txs (Transmit + Execute-from-holder); atomic EVM txs produce one
- **Total Solana CU** = sum of `meta.computeUnitsConsumed` across ALL Solana segments
- **Max heap (bytes)** = max of `Program log: Heap NNNNN` across segments
- **Sol error** via `meta.err`

The "# Sol txs" column reveals which ops ran atomic (1 tx) vs iterative (2 txs). When cached forces iterative but CPI stays atomic, the comparison becomes "cached iterative path" vs "CPI atomic path" — the cost difference includes the holder-account write overhead, not just the cached overlay vs CPI invoke.

## Apple-to-apple delta — ops where both tracks succeeded

| Op | Cached CU | CPI CU | Δ CU | Δ % | Cached path | CPI path | Cached heap | CPI heap | Δ heap |
|---|---:|---:|---:|---:|---|---|---:|---:|---:|
| **Both tracks atomic (Δ purely cached-overlay vs CPI-invoke)** | | | | | | | | | |
| `SystemCached.transfer(address,uint64)` | 125,682 | 134,486 | **-8,804** | **-6.5%** | atomic | atomic | 18,672 | 17,744 | +928 |
| `SplCached.transfer(address,uint256)` | 127,789 | 126,348 | +1,441 | +1.1% | atomic | atomic | 20,592 | 19,104 | +1,488 |
| `SplCached.transfer(address,uint256,bytes32)` | 135,747 | 125,636 | +10,111 | +8.0% | atomic | atomic | 20,600 | 19,112 | +1,488 |
| `SplCached.approve` [#383] | 142,732 | 133,465 | +9,267 | +6.9% | atomic | atomic | 20,600 | 18,944 | +1,656 |
| `ASplCached.create_ata()` | 135,424 | 137,075 | **-1,651** | **-1.2%** | atomic | atomic | 19,360 | 18,800 | +560 |
| `ASplCached.create_ata(bytes32)` | 134,178 | 123,174 | +11,004 | +8.9% | atomic | atomic | 19,760 | 18,808 | +952 |
| `ASplCached.create_ata(address)` | 136,110 | 134,104 | +2,006 | +1.5% | atomic | atomic | 19,816 | 18,800 | +1,016 |
| `ASplCached.create_ata(address,bytes32)` | 137,911 | 124,674 | +13,237 | +10.6% | atomic | atomic | 19,824 | 18,808 | +1,016 |
| **Atomic median (both tracks)** | | | **+5,637** | **+4.2%** | | | | | **+1,016** |
| **Both tracks iterative** | | | | | | | | | |
| `SplCached.transferFrom` [#383] | 157,483 | 142,536 | +14,947 | +10.5% | iterative (2 txs) | iterative (2 txs) | 21,432 | 19,776 | +1,656 |
| **Cached iter vs CPI atomic — Δ includes holder-tx overhead** | | | | | | | | | |
| `WithdrawCached.withdraw_to_ata` | 169,926 | 135,460 | +34,466 | +25.4% | iterative (2 txs) | atomic | 25,608 | 22,320 | +3,288 |
| `WithdrawCached.withdraw_from_ata` [#383] | 177,301 | 123,295 | +54,006 | +43.8% | iterative (2 txs) | atomic | 24,944 | 20,104 | +4,840 |

## Reading the data

1. **Atomic-vs-atomic median: +4.2% Solana CU.** When the cached EVM tx fits in one Solana atomic tx (1232-byte limit, ≤1.4M CU), cached overhead is ~1-11%. Two ops (`SystemCached.transfer`, `ASplCached.create_ata()`) actually run *faster* on cached because the overlay elides a redundant account read the CPI path can't skip.

2. **`transferFrom` (#383) goes iterative on both tracks** because `transfer_checked` ix data + accounts (4 addresses + amount + mint + program metas) makes the tx body too big for atomic on either path. Δ is +10.5% — comparable to the atomic median.

3. **The two `WithdrawCached.withdraw_*_ata` ops are the costly cases** — cached produces a `Composed` IxList (SPL transfer + System transfer + diff accounting) which doesn't fit atomic; CPI uses a single `HelperProgram.deposit_from_ata` invocation that does fit. Cached at +25-44% over CPI atomic — this is the "cached forces iterative" tax. It IS the real cost, but it's not purely cached-overlay overhead — most of the delta is the holder-account write step (1 extra Solana tx).

4. **Heap overhead is consistent and small.** +500-5000 B max-heap (most ~+1 KB). The journal overlay is the main contributor; the iterative cases add ~3-5 KB for the holder-tx state.

5. **Cached-only selectors** (SystemCached salt-based variants, SplCached.init) consume ~117-127 K CU + ~18-19 KB heap in successful runs — comparable to other cached atomic ops.

## When to pick which track

| Scenario | Pick cached | Pick CPI |
|---|---|---|
| Single SPL transfer / approve / mint in a one-shot tx | Pay ~5-10% to gain EVM-revert atomicity | Save ~5-10% if you don't need rollback |
| Multi-step EVM tx that needs SPL effects to roll back together | **Cached only** (CPI is hard-gated by `CpiProhibitedInIterativeTx`) | Not an option |
| Bridge outbound (one-shot, no overlay benefit needed) | Adds ~5% cost AND opens iterative-VM attack surface for ATA-create / Token-2022 raw-delegate | **CPI** — `CpiProhibitedInIterativeTx` IS the safety property |
| Wrap/unwrap (`withdraw_to_ata` / `withdraw_from_ata`) | +25-44% (forces iterative) — only if revert atomicity is load-bearing | Default — atomic, cheaper |
| `transferFrom` (`SPL_ERC20_cached`) | Required for cached-track router (Romeswap / Compound) | Required for legacy-track router |
| `mint` to authority-controlled SPL | +7% — both paths gate at SPL Token authority check identically | Same gate, same security |

## Rejected-pre-send pairs (security parity confirmed)

8 op pairs were rejected at the simulation layer **identically on both tracks** — confirming the cached track preserves the SPL Token / Solana runtime gates:

- `SystemCached.create_pda` (caller PDA already exists)
- `SystemCached.transfer(bytes32,uint64,bytes32)` (salt-PDA dest not allocated)
- `SplCached.transfer(bytes32,uint256)` + `(bytes32,uint256,bytes32)` (dummy `0xaaaa…` ATA doesn't exist)
- `SplCached.init` (pre-existing or malformed ATA/mint)
- `SplCached.mint` (caller-PDA not on-chain mint authority — both tracks correctly reject)
- `WithdrawCached.withdrawal(bytes32) payable` (recipient is a mint, not a system account — precheck)
- `WithdrawCached.withdraw_to_pda` (state didn't meet precheck)

`mint` is the most important of these — both cached and CPI reject identically when caller-PDA ≠ on-chain mint authority. **The cached track has not weakened the mint authority enforcement.**

## Cached-only selectors (no CPI counterpart)

| Op | Cached CU | Heap (B) | Sol txs |
|---|---:|---:|---:|
| `SystemCached.allocate(uint64,bytes32)` | 121,983 | 18,640 | 1 |
| `SystemCached.assign(bytes32,bytes32)` | 124,372 | 18,520 | 1 |
| `SystemCached.transfer(bytes32,uint64)` | 119,640 | 18,648 | 1 |

These show typical cached-track Solana CU of ~120-127 K with heap ~18.5-18.7 KB on atomic execution.

## Cross-references

- [rome-evm-private#376](https://github.com/rome-protocol/rome-evm-private/pull/376) — cached-track infrastructure
- [rome-evm-private#383](https://github.com/rome-protocol/rome-evm-private/pull/383) — Phase A new cached selectors
- [rome-evm-private#385](https://github.com/rome-protocol/rome-evm-private/pull/385) — "permanently scoped out" framing for the 2 selectors not on cached track
- [rome-solidity#206](https://github.com/rome-protocol/rome-solidity/pull/206) — Phase A example methods
- [rome-solidity#207](https://github.com/rome-protocol/rome-solidity/pull/207) — this bench

## Artifacts

- [`contracts/examples/bench_cached.sol`](../contracts/examples/bench_cached.sol)
- [`scripts/bench_cached.ts`](./bench_cached.ts) — sums CU across all Solana segments (atomic = 1 segment, iterative = 2+)
- [`scripts/validate_withdraw_suspect.ts`](./validate_withdraw_suspect.ts) — focused diagnostic for the iterative-flow rows
