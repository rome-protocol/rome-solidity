# Rome Bridge

Cross-chain bridge between **Ethereum Sepolia** and **Rome rome devnet** using **Circle CCTP** for USDC and **Wormhole Token Bridge** for ETH (Phase 1 — Ethereum-origin assets), plus a **generic Rome → Solana SPL outbound** for any wrapper deployed by `ERC20SPLFactory` (Phase 2 — Solana-native and Solana-bridged SPLs).

Token nomenclature follows the canonical W-prefix standard documented in [`/CLAUDE.md` § "Token nomenclature"](../../CLAUDE.md#token-nomenclature--canonical-repo-wide). Native gas keeps its bare symbol (`USDC` on Rome); ERC20-SPL wrappers get `W` (e.g. `WUSDC`, `WETH`, `WSOL`).

This document covers what the bridge does, how it's wired, how to redeploy it, and — most importantly — the non-obvious problems that came up during bring-up and the fixes that unblocked them. Read the "Problems faced and fixes" section before touching the code.

---

## Assets and flows

| Asset | Rome wrapper | Source of truth on Solana | Bridge mechanism |
|-------|------------|----------------------------|------------------|
| USDC  | `WUSDC` (`SPL_ERC20`) | Circle's devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | **CCTP** (native mint/burn, no wrapped tokens) — Phase 1 |
| ETH   | `WETH`  (`SPL_ERC20`) | Wormhole-wrapped Sepolia-ETH mint `6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs` | **Wormhole Token Bridge** (lock-and-mint / burn-and-unlock) — Phase 1 |
| SOL (or any Solana-native SPL) | `WSOL` / `W{Symbol}` (`SPL_ERC20`) | Canonical wSOL `So11…` (or any SPL mint) | **Direct CPI** (`bridgeOutToSolana` for outbound; native deposit for inbound) — Phase 2 |

Both assets flow as SPL tokens between Solana and Ethereum. On the Rome side, an `SPL_ERC20` wrapper exposes each SPL mint as an ERC-20 so users can interact with standard wallets. The wrapper is a 1:1 view over the user's Solana ATA — there is no additional custody.

**Rome's gas mint is `USDC` (bare).** The `WUSDC` wrapper above is a distinct token from native gas — same underlying SPL, different surface (BalancePDA vs SPL_ERC20). The bridge picker on the app filters out `WUSDC` from the Rome → Solana picker because the native gas withdraw path covers the same destination ATA. See the app CLAUDE.md § "Bridge asset picker".

The four CCTP/Wormhole flows (Phase 1):

```
                                         Sepolia                                  Rome rome (Solana)
                                    ┌──────────────────┐                     ┌────────────────────────┐
  Inbound CCTP   (user on Sepolia)  │  depositForBurn  │ ── IRIS attest ──►  │  receiveMessage (CPI)  │  → WUSDC minted to user ATA
  Outbound CCTP  (user on Rome)     │  receiveMessage  │ ◄── IRIS attest ──  │  burnUSDC → CCTP CPI   │  → WUSDC burned
  Inbound Wh     (user on Sepolia)  │  transferTokens  │ ── Guardian VAA ─►  │  complete_transfer_..  │  → WETH minted
  Outbound Wh    (user on Rome)     │  completeAndUnw..│ ◄── Guardian VAA ─  │  approveBurnETH+burnETH│  → WETH burned
                                    └──────────────────┘                     └────────────────────────┘
```

The two Phase-2 flows (Rome ↔ Solana, any SPL):

```
                                                                                  Rome rome (Solana)
                                                                              ┌─────────────────────────────┐
  Outbound Phase 2 (user on Rome → Solana wallet)                             │ bridgeOutToSolana (inlines ATA-create) │ → SPL minted to recipient ATA
  Inbound Phase 2  (user on Solana → Rome) — native deposit                  │ user signs Solana SPL transfer ; Hercules indexes; W{Symbol} balance reflects │
                                                                              └─────────────────────────────┘
```

Attestation/VAA fetching and the return-leg submission happen off-chain in the bridge relayer (`the app/src/server/bridge/`). The on-chain side is four Solana CPIs from Rome plus four Sepolia transactions.

---

## Architecture

### On Rome (this repo — `rome-solidity`)

Three bridge contracts on the `<chain>` devnet EVM:

- **`SPL_ERC20`** (`WUSDC`, `WETH`, `WSOL`, plus any future `W{Symbol}` deployed via the factory) — generic ERC-20 wrapper for any SPL mint. Binds the mint to a standard ERC-20 interface (`balanceOf` reads `getATA(AUTHORITY_PDA, mint)`, transfers/approvals go through Rome's CPI precompile). Phase-2 generic outbound (`bridgeOutToSolana` + `ensureRecipientAta`) lives here — see § "Generic Rome → Solana SPL outbound" below.
- **`RomeBridgeWithdraw`** — entrypoint for outbound flows. `burnUSDC(amount, ethRecipient)` fires a CCTP `depositForBurn` CPI. `approveBurnETH(amount)` + `burnETH(amount, ethRecipient)` (two separate EVM txs — see "Problems faced") fire an SPL Token Approve CPI then a Wormhole `transferWrapped` CPI. The contract takes all Solana program IDs, sysvars, and PDAs through its constructor so it is network-agnostic.
- **`RomeBridgePaymaster`** — ERC-2771 trusted forwarder with per-user 3-tx sponsorship cap and a `(target, selector)` allowlist. **Legacy — no longer used by the active bridge worker.** The current inbound flow uses `settle_inbound_bridge` on rome-evm-private signed by `the settle payer key`, no Rome EVM tx involved. Kept in chain.contracts config for back-compat parsing only.

`IWormholeTokenBridge.sol` and `ICCTP.sol` encode the Solana instructions and account lists for the two CPI targets. All Solana program IDs and sysvar addresses are constructor params, not constants.

### On Solana (external programs Rome CPIs into)

Devnet program IDs, all already deployed by Circle / Wormhole — we only CPI into them:

| Program | ID | Role |
|---------|----|----|
| CCTP Token Messenger Minter | `CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3` | Burns/mints USDC via Circle's native bridge |
| CCTP Message Transmitter    | `CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd` | Posts the Circle message event |
| Wormhole Token Bridge (devnet) | `DZnkkTmCiFWfYTfT41X3Rd1kDgozqzxWaHqsw6W4x2oe` | Wraps/unwraps tokens, emits Wormhole messages |
| Wormhole Core (devnet)      | `3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5` | Posts VAA messages, publishes Guardian events |
| SPL Token                   | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | Mint/burn/transfer/approve |

The Wormhole devnet programs are different from mainnet IDs — see `scripts/bridge/constants.ts` (`SOLANA_PROGRAM_IDS_DEVNET`).

### Generic Rome → Solana SPL outbound (`SPL_ERC20.bridgeOutToSolana`)

A complement to Phase 1's CCTP/Wormhole outbound paths. **Solana-native SPL tokens don't need a cross-chain protocol to leave Rome** — Rome is a Solidity-on-Solana view layer, so the user's tokens already live on Solana in their PDA-ATA. "Bridging" to Solana is just an SPL transfer with the right authority signing. One pair of methods on the SPL_ERC20 base contract covers every wrapper the factory will ever deploy.

| Method | Role |
|---|---|
| `bridgeOutToSolana(bytes32 recipient, uint256 value) → bool` | Two CPIs in one atomic Rome tx: (1) `AssociatedToken.CreateIdempotent` for the recipient ATA, funded by `msg.sender`'s unified user PDA (no-ops when the ATA already exists); (2) SPL `transfer_checked` from `getATA(AUTHORITY_PDA, mint)` → recipient ATA. Authority = `AUTHORITY_PDA = find_program_address([EXTERNAL_AUTHORITY, evmAddr])`. Emits `BridgedOutToSolana`. |
| `ensureRecipientAta(bytes32 recipient) → bytes32` | Standalone idempotent ATA-create helper. Funded by sender's unified user PDA. Emits `RecipientAtaEnsured`. Kept as a public utility — `bridgeOutToSolana` no longer requires this as a preflight (the create CPI is inlined). |

Post-2026-05-15 collapse: `bridgeOutToSolana` inlines the recipient-ATA-create CPI internally. The legacy two-step preflight pattern (probe Solana → call `ensureRecipientAta` if missing → call `bridgeOutToSolana`) is no longer required; the the app hook drops the probe-then-call dance. The atomic two-CPI Rome DoTx fits under the 1.4M CU budget (the 5-CPI activator tx measures ~234K CU mean on Hadrian; a 2-CPI bridgeOut sits comfortably below that).

**Asset-origin asymmetry** — combined with Phase 1:

| Asset origin | Inbound | Outbound | Per-asset Solidity? |
|---|---|---|---|
| Originates on Ethereum (USDC, ETH, future ERC20s) | CCTP / Wormhole | `RomeBridgeWithdraw.{burnUSDC, burnETH}` | Yes — one method per protocol |
| Native to Solana (any SPL deployed via `add_spl_token_no_metadata`) | Send SPL to PDA-ATA | **`bridgeOutToSolana`** | **No — one method covers every wrapper** |

Frontend consumer: `the app/src/features/bridge/hooks/useOutboundSplBridge.ts`. See "Cross-repo dependencies — the app" in `/CLAUDE.md` (rome-solidity root) for the full ABI + behavioral-contract map.

### Off-chain (bridge relayer and UI — `the app`)

The four flows are multi-step (source-chain tx → fetch attestation → target-chain tx). The relayer is an off-chain state machine:

- `src/server/bridge/flows/inboundCctp.ts` — polls Circle IRIS `/messages/{domain}/{txHash}` for the message+attestation, then submits `receiveMessage` on Solana.
- `src/server/bridge/flows/outboundCctp.ts` — looks up the Solana sig for the `burnUSDC` EVM tx via `rome_solanaTxForEvmTx`, polls IRIS for the attestation, submits `receiveMessage` on Sepolia.
- `src/server/bridge/flows/inboundWormhole.ts` — polls Wormholescan for the VAA, submits `complete_transfer_wrapped` on Solana (uses `@wormhole-foundation/sdk-solana-tokenbridge`).
- `src/server/bridge/flows/outboundWormhole.ts` — parses the Wormhole Sequence from Rome's Solana logs, polls Wormholescan for the VAA, submits `completeTransferAndUnwrapETH` on Sepolia.

The frontend (`src/features/bridge/hooks/`) handles source-chain signing and polls the relayer for completion.

---

## Current deployment (rome devnet)

From `deployments/rome.json`:

| Contract | Address |
|----------|---------|
| RomeBridgePaymaster (legacy, retained for back-compat parsing) | `0xcaf1fbcf60c3686d87d0a5111f340a99250ce4ef` |
| ERC20Users | `0x803f6923bcc776db1d0aa6fcdbd8ceddf35ad6f3` |
| SPL_ERC20 `WUSDC` (Phase-1 USDC wrapper) | `0x6ed2944bba4cb5b1cb295541f315c648658dd67c` |
| SPL_ERC20 `WETH` (v9 — bridgeOutToSolana + ensureRecipientAta) | `0x613b22c098b1058d91731dcb15beaa781b45783e` |
| SPL_ERC20 `WSOL` (v9 — bridgeOutToSolana + ensureRecipientAta) | `0x1b23b52d9c991d580ae6df1b936aff09a5f794a2` |
| RomeBridgeWithdraw | `0x513f76e39cfd7008f1e143ae37148608cddfcaaf` (Wormhole target chain = 10002 Sepolia) |

The deployed `WUSDC` is still the original Phase-1 wrapper (no `bridgeOutToSolana`); see `the app` BridgePage filter logic for why this is fine — outbound USDC routes through the native Withdraw precompile (`0x42…0016`), not via the wrapper.

---

## Problems faced and how they were fixed

Each subsection here is a real incident that blocked a flow and cost time to diagnose. If you are bringing the bridge up again for a new chain or re-deploying, read these first — the fixes aren't things you would think of cold.

### 1. Two CPIs in a single Rome EVM transaction exceed Solana's compute budget

**Symptom.** `burnETH` failed on-chain with `Error processing Instruction 2: Computational budget exceeded`. The Rome `DoTx` instruction consumed 1,399,644 of 1,399,700 compute units before Wormhole's `transfer_wrapped` even finished its inner burn-and-post-message CPIs.

**Why.** Rome forces atomic mode whenever any CPI happens in the EVM tx: `is_atomic = steps_executed <= NUMBER_OPCODES_PER_TX && ... || found_cpi` (`rome-evm-private/emulator/src/api/mod.rs`). Iterative mode (which splits execution across multiple Solana txs) is not safe for CPIs because CPI side effects can't be replayed. That means every CPI-bearing EVM tx is one Solana tx, capped at 1.4M CU. Rome's DoTx overhead (EVM interpretation, account loading, state merge for a contract with ~20 writable accounts) is ~1.3M CU. Wormhole's `transfer_wrapped` needs ~300K CU. Two CPIs don't fit.

**Fix.** Split the outbound Wormhole path into two EVM txs:
1. `approveBurnETH(amount)` — single CPI: SPL Token Approve, delegating Wormhole's `authority_signer` PDA to burn the user's ATA.
2. `burnETH(amount, ethRecipient)` — single CPI: Wormhole `transfer_wrapped`, which internally burns via the delegate from step 1.

Each tx now fits the budget. This is also the standard ERC-20 bridge pattern (approve then bridge), so the UX isn't a regression. Frontend: `src/features/bridge/hooks/useOutboundWhSend.ts` sends both txs in sequence.

**CCTP doesn't hit this.** Circle's `depositForBurn` is one CPI and fits in atomic mode — `burnUSDC` stays a single EVM tx.

**Don't try to optimize out of this with Yul/assembly.** The overhead is Solana CU inside Rome's EVM, not EVM-bytecode gas. Yul saves at most a few thousand CU out of 1.4M.

### 2. Wormhole `transfer_wrapped` needs a prior SPL Token Approve

**Symptom.** Early tries of `burnETH` (before the two-tx split) returned SPL Token error `0x4` — "owner does not match" — even when the ATA data clearly showed `userPda` as the owner.

**Why.** Wormhole's `transfer_wrapped` doesn't burn with the user as authority. It burns via its own `authority_signer` PDA and signs that CPI with the token-bridge program's seeds. For that burn to succeed, the source ATA must have an SPL Token `Approve` in place pointing to `authority_signer` as the delegate. The Wormhole SDK always emits this as a companion instruction (`@wormhole-foundation/sdk-solana-tokenbridge: approve.js → createApproveAuthoritySignerInstruction`). There is a prior commit (`2fc6931`) that removed this approve with an incorrect claim that Wormhole handles it internally. Wormhole does not.

**Fix.** `approveBurnETH(amount)` does the SPL Token Approve CPI. Must run as a separate EVM tx before `burnETH` (because of problem #1). See `contracts/bridge/RomeBridgeWithdraw.sol`.

### 3. A stale wETH mint constant caused Wormhole to reject the whole instruction

**Symptom.** `transfer_wrapped` failed with `Program log: Error: IoError(Custom { kind: InvalidInput, error: "Unexpected length of input" })` — a Borsh deserialization error from inside the token-bridge program.

**Why.** `SPL_MINTS_DEVNET.WETH_WORMHOLE` in `scripts/bridge/constants.ts` was set to an old test mint (`2kCwKGBvGfoY7EKHPmCwsZXamxzDMbqn1uDZMqXfve6i`) while the on-chain WETH wrapper bound to the actual canonical Wormhole-wrapped Sepolia-ETH mint (`6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs`). The deploy script derived `wrappedMeta` from the wrong mint, got a PDA that doesn't exist on chain (empty account data), and Wormhole failed when it tried to deserialize zero bytes as its `WrappedMeta` struct.

**Fix.** `SPL_MINTS_DEVNET.WETH_WORMHOLE` now points at the canonical wrapped-Sepolia-ETH mint derived via `deriveCanonicalWrappedMint({ tokenChain: 10002, tokenAddress: "eef12a83..." })`. When you redeploy the WETH wrapper, always derive the mint using `lib/canonical-mint.ts` + `lib/verify-mint-on-chain.ts` rather than hard-coding it.

**Generalize.** If a Wormhole CPI fails with "Unexpected length of input", suspect an account PDA that doesn't exist on chain long before you suspect instruction-data encoding.

### 4. Rome masks CPI errors with `CannotRevertCpi`

**Symptom.** `rome_emulateTx` and `eth_sendRawTransaction` returned generic `"execution reverted: Cannot revert cross-program invocation"` for every bridge failure, regardless of the underlying cause. No actionable info reached the client.

**Why.** Once any CPI has been attempted, Rome sets `found_cpi = true` (before executing). If the EVM then tries to revert the frame, Rome replaces the revert data with `CannotRevertCpi` (`program/src/vm/vm.rs:434`). This is intentional — the CPI's real side effects on Solana can't be rolled back — but it destroys the specific error data from the failed CPI.

**Debugging approach.** Inspect the proxy's logs on the node serving the chain (grep for `mollusk`, `error`, `custom program`). The real Solana program error appears in the `non-evm call error: SimulateTransactionError: mollusk error: Failure(Custom(0))` line along with full Solana logs. Do this first when a CPI fails unexplained.

### 5. `block.number` on Rome EVM is the Solana slot, not stable inside a tx

**Symptom.** CCTP outbound initially used `block.number` as part of the salt for the transient `messageSentEventData` PDA. The emulator would pass one PDA; by the time the on-chain tx ran, `block.number` had changed and the program computed a different PDA → `AccountNotFound`.

**Why.** On Rome EVM, `block.number` returns the current Solana slot (`rome-evm-private/program/src/state/handler.rs: block_number() → self.slot`). Slots advance every 400ms; emulation and execution happen on different slots.

**Fix.** Per-user monotonic counter in storage (`mapping(address => uint64) burnNonce`). Stable within a tx, unique across txs. Also include `address(this)` in the salt so redeploys don't collide with PDAs used under the previous contract address. See the salt derivation at the top of `burnUSDC` / `burnETH`.

**Rule of thumb.** Never use `block.number`, `block.timestamp`, or `blockhash` in PDAs or anywhere the value has to agree between emulation and execution.

### 6. ATA creation must be idempotent when the same ATA is touched by multiple paths

**Symptom.** After an inbound Wormhole flow created the user's WETH ATA externally (via `createAssociatedTokenAccount`), subsequent Rome operations tried to create the same ATA via the non-idempotent `create` CPI and reverted with `Cannot revert CPI` — the ATA already existed.

**Fix.** `erc20spl.sol` uses `create_associated_token_account_idempotent` for the Rome-side creation. If the ATA exists, this is a no-op.

### 7. The 17-account Wormhole `transfer_wrapped` account list is tightly ordered and subtly different from `transfer_native`

**Symptom.** Multiple redeploy cycles to chase down `InvalidAccountData` errors from Wormhole — wrong number of accounts, wrong mutability flags, wrong order.

**Fix.** Derive the account list directly from the IDL. `IWormholeTokenBridge.sol: buildTransferWrappedAccounts` mirrors the account layout at `@wormhole-foundation/sdk-solana-tokenbridge: dist/esm/utils/tokenBridge/instructions/transferWrapped.js` exactly: 17 accounts (no `sender`), `from_owner` is **signer + writable**, `authority_signer` is **readonly**, `mint` is **writable**, `wormhole_core` and `token` come at the end. Before changing the layout, diff against `scripts/diff-wh-transfer-wrapped.mjs` in `the app` which runs the SDK builder and prints the exact accounts Wormhole expects.

### 8. Wormhole destination chain id was hardcoded to Ethereum mainnet

**Symptom.** Outbound Wormhole E2E: Rome burn succeeded, VAA was emitted, `completeTransferAndUnwrapETH` on Sepolia reverted with `"invalid target chain"`.

**Why.** `RomeBridgeWithdraw.burnETH` hardcoded `targetChain: 2` — Ethereum **mainnet**'s Wormhole chain id. Sepolia has chain id **10002** on the Wormhole testnet. The VAA was produced targeting the wrong chain; the Sepolia Token Bridge refused to redeem it.

**Fix.** Added `wormholeTargetChain` as an immutable constructor param, set per deploy. `deploy.ts` / `redeploy-withdraw-devnet-wh.ts` default to `10002` for rome/local; `redeploy-withdraw-only.ts` (mainnet path) uses `2`. Future chain swaps just change this constructor arg rather than the contract source.

### 9. Proxy needed a new RPC method to look up Solana sigs for an EVM tx

**Symptom.** The outbound flows need to know the Solana signature of the Rome tx so the relayer can scrape Wormhole logs / poll IRIS. There was no proxy RPC for this — logs had it, but clients couldn't.

**Fix.** Added `rome_solanaTxForEvmTx(evmTxHash)` to the proxy. It queries the `evm_tx_sol_tx` table and returns an array of Solana signatures.

---

## Setup / redeploy

For a fresh deploy on a new Rome chain or to refresh rome:

1. **Verify devnet program IDs** are live on your Solana cluster. All four (CCTP Token Messenger, CCTP Message Transmitter, Wormhole Token Bridge devnet, Wormhole Core devnet) are deployed on Solana devnet — no action needed unless you're on a different cluster.

2. **Resolve the canonical wrapped-ETH mint** for your target Ethereum network using `scripts/bridge/resolve-canonical-weth.ts`. If you are not bridging from Sepolia, update `SEPOLIA_WETH_TOKEN_CHAIN` and `SEPOLIA_WETH_TOKEN_ADDR` in `scripts/bridge/redeploy-withdraw-canonical-weth.ts` and `constants.ts`. Verify the mint exists on chain (`lib/verify-mint-on-chain.ts`).

3. **Deploy** via `scripts/bridge/deploy.ts` (full deploy) or `scripts/bridge/redeploy-withdraw-devnet-wh.ts` (keep paymaster + wrappers, refresh `RomeBridgeWithdraw`). Both scripts write `deployments/{network}.json`.

4. **Allowlist selectors on the paymaster**. The deploy scripts allowlist `burnUSDC` and `burnETH` automatically. `approveBurnETH` is allowlisted by `scripts/bridge/allowlist-approve-selector.ts` — run it after redeploy.

5. **Verify the proxy supports `rome_solanaTxForEvmTx`** for the target Rome chain. If not, the outbound Wormhole/CCTP relayer flows will not be able to find Solana sigs.

6. **Smoke test**:
   ```bash
   npx hardhat run scripts/bridge/smoke-emulate-all.ts --network <chain>
   ```
   Checks that `burnUSDC` and `approveBurnETH` emulate cleanly. `burnETH` is explicitly skipped in the smoke test — it requires a prior on-chain approve.

7. **Update the frontend** (`the app`) `CHAIN_WITHDRAW` address in `src/features/bridge/hooks/useOutboundWhSend.ts` and any CCTP hook file.

## Test flows end to end

- **Inbound CCTP** (Sepolia → Rome WUSDC): `scripts/bridge/inbound/01-submit-deposit.mjs` → `02-poll-attestation.mjs` → `03-submit-receive.mjs`.
- **Outbound CCTP** (Rome WUSDC → Sepolia): `scripts/bridge/submit-burn.ts` then wait for the relayer to advance the record. Or call the UI.
- **Inbound Wormhole** (Sepolia → Rome WETH): `scripts/bridge/inbound/01b-submit-whETH.mjs` → relayer advances → balance appears.
- **Outbound Wormhole** (Rome WETH → Sepolia): `scripts/bridge/submit-burnETH.ts` sends `approveBurnETH` then `burnETH`, waits for Sepolia completion.

All four have been verified E2E on rome against Sepolia with real funds:
- Inbound CCTP: Sepolia `0x484c00f5...` → Solana `WS6QkvCJ...`
- Outbound CCTP: Rome `0xb7d70b64...` → Solana `37iR6YNA...` → Sepolia `0x45a67f6d...`
- Inbound Wh: Sepolia `0xe9d25c2e...` (seq 343916) → Solana `nPKVXZ3m...`
- Outbound Wh: Rome `0x22e85b5f...` → Solana `5hdP2zTh...` (seq 56746) → Sepolia `0x72252591...`

### Note: gas price on rome devnet

rome's gas token is `USDC` (bare — native gas mint), priced against `SOL` via a Meteora pool between the `WUSDC` and `WSOL` SPL_ERC20 wrappers. The proxy reports a default `eth_gasPrice` of ~10 gwei — but because the pool price can swing, the resulting **Wei balance per USDC is variable**. If the native balance check rejects a tx with `"User does not have sufficient funds (Wei)"` despite having plenty of `USDC`, override `gasPrice` downward (1-2 gwei works on rome). The submit-burnETH runner uses 2 gwei by default for this reason.

---

## Reading the code

Start here:

- `contracts/bridge/RomeBridgeWithdraw.sol` — entrypoint contract. The outbound side of both flows lives here. Read the NatSpec on `burnETH` / `approveBurnETH` for the split-tx rationale.
- `contracts/bridge/IWormholeTokenBridge.sol` — Wormhole account layout. The long comment on `TransferWrappedAccounts` lists the exact order and mutability; match it to the IDL before changing.
- `contracts/bridge/ICCTP.sol` — CCTP `depositForBurn` layout (17 accounts per Circle's IDL).
- `scripts/bridge/derive/wormhole-accounts.ts` — PDA derivations. `wrappedMeta` depends on the mint — keep it in sync with the deployed WETH wrapper.
- `scripts/bridge/constants.ts` — Solana program IDs (mainnet vs devnet) and SPL mints. **`SPL_MINTS_DEVNET.WETH_WORMHOLE` must match the canonical wrapped-ETH mint for the source chain you're bridging from.**

For the off-chain half, see `the app/src/server/bridge/` (flows and Wormhole/CCTP helpers) and `the app/src/features/bridge/` (hooks and UI).

---

## Design reference

Original spec: `docs/superpowers/specs/2026-03-12-rome-bridge-phase1-design.md`. Implementation plans: `docs/superpowers/plans/2026-03-12-rome-bridge-phase1-*.md`.
