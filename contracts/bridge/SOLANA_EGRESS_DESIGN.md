# Bridge: Rome → Solana SPL egress (EVM/MetaMask user) — design

**Status:** draft · **Base:** `origin/master @ c1398fe` (synced) · **Branch:** `feat-bridge-out-solana-evm`

## Goal
Let an **EVM/MetaMask user** send a held SPL wrapper (wSOL, wETH, wUSDC, … any mint) **back to an arbitrary Solana recipient**, on a cached-wrapper chain (Trajan and forward).

## Verified problem (re-verified against synced master)
- The deployed Trajan wrappers are a **stale build** — bytecode has **no `bridgeOutToSolana` selector at all** → rome-ui's call hits the fallback → empty revert. (Not the iterative-CPI gate; not "#364 version-skew" — both prior theories disproven.)
- The legacy `SPL_ERC20.bridgeOutToSolana` did **two CPIs in one tx** (`create_ata_for_key` + `transfer_spl`) → tx went iterative → `CpiProhibitedInIterativeTx`. That's why the *old* design was fragile even where deployed.

## Decision: flow B — EVM/MetaMask → arbitrary Solana recipient
`transfer_spl_to_signer(uint64,bytes32)` (#223) is **ruled out** here: it returns to the *outer Solana tx signer's* ATA, which is the real wallet only for **synthetic / Solana-native `do_tx_unsigned` users**. A MetaMask user's signer is the proxy payer, so it would misdeliver. (Keep it in mind for a future Solana-native return-leg, separately.)

## Primitive used (synced, exists)
`HelperProgram.transfer_spl(bytes32 to_ata, uint64 amount, bytes32 mint)` (`0xb6977879`, legacy) — moves SPL from `ata(external_auth(caller), mint)` → an explicit recipient ATA, signed as `external_auth(caller)`.

## Design
Add to **`RomeBridgeWithdraw`** (the bridge contract — egress belongs here, not on the token wrapper), parameterized by `mint` (any asset), **legacy-track** (consistent with `burnUSDC`/`burnETH`):

1. **`bridgeOutToSolana(bytes32 solanaRecipient, uint256 amount, bytes32 mint)`** — **transfer-only** (1 CPI, atomic). Derives `to_ata = ataForKey(recipient, mint)` (read), then `transfer_spl(to_ata, amount, mint)`. **No internal `create_ata_for_key`** — this is the fix for the 2-CPI→iterative→revert bug.
2. **`ensureRecipientAta(bytes32 solanaRecipient, bytes32 mint)`** — `create_ata_for_key` (1 CPI, atomic), **separate tx**, only when the recipient ATA is missing.

**Orchestration (rome-ui `useOutboundSplBridge`, already 2-step):** probe recipient ATA on Solana → if missing, tx1 `ensureRecipientAta` → tx2 `bridgeOutToSolana`. Each tx is single-CPI/atomic/legacy → never trips the iterative gate.

**Payment:** `create_ata_for_key` rent is operator-fronted, reimbursed via Rome gas accounting (user pays via gas) — or the recipient self-creates their ATA on Solana (no Rome create needed). No new subsidy.

## Why not the alternatives
- **Cached track for egress:** can't — the bridge's CCTP/Wormhole paths use `approve_spl_raw_delegate` + `invoke_signed`, **permanently legacy-only by rome-evm security design**. The contract stays legacy-track; it remains fully **cached-wrapper-compatible** (operates on the shared underlying ATA; `balanceOf` reads via `SplCached.account`).
- **On the SPL wrapper:** bridge logic on a token contract is a separation-of-concerns smell; egress belongs in the bridge contract.

## Cleanup (drop dead legacy)
- Drop `RomeBridgePaymaster`, `RomeBridgeInbound` from the active surface (legacy; inbound is `settle_inbound_bridge` now). Update `setup-local.ts` + `deploy-withdraw-on-existing-paymaster.ts` that still reference them.

## Future-proof
- **Any asset:** parameterize by `mint` (not hardcoded usdc/weth immutables).
- **Multi-EVM-chain** ("Trump" + others): the CCTP/WH paths are already network-agnostic (Solana program IDs from constructor); adding chains = config/domain, not new code.

## rome-ui (separate, in-scope)
- Re-point `useOutboundSplBridge` from the wrapper to `RomeBridgeWithdraw.bridgeOutToSolana`.
- **Show any number of assets** (SOL, JITO, BTC, …) in the Solana↔Rome pickers — drive from registry/config **by mint** (canonical-identity work), reusing the existing `useNativeDepositSend(mintBase58)` for inbound. Not blocked by the contract change.

## TDD + PR plan
1. Failing test: a pure-Solidity validation mirror (like `BridgeOutCollapseHelper`) for the new `bridgeOutToSolana` input gates + the `ensureRecipientAta`-skip predicate. (The CPI itself needs a live chain — integration test post-deploy.)
2. Implement minimal → green.
3. Deploy a current `RomeBridgeWithdraw` on Trajan; live integration test (round-trip + fresh recipient).
4. rome-ui re-point + picker, with funded e2e.

## Open items / risks
- Coordinate with `rome-evm-private/unsigned_flow` (active) so the Solana-native return-leg and this EVM path don't diverge.
- Local-only `rome-solidity` commit `db4f6b4` (hadrian v6 token wrappers) is unpushed — confirm intent before any master sync.
- Trajan's stale **program** may also predate the primitives the current contracts use — redeploy must verify program support (same class as the proxy version-skew the gamut hit).
