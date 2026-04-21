# Rome Bridge (Phase 1)

Cross-chain bridge between **Ethereum Sepolia** and **Rome marcus devnet** using **Circle CCTP** for USDC and **Wormhole Token Bridge** for ETH. Four flows total: inbound and outbound for each asset.

This document covers what the bridge does, how it's wired, how to redeploy it, and — most importantly — the non-obvious problems that came up during bring-up and the fixes that unblocked them. Read the "Problems faced and fixes" section before touching the code.

---

## Assets and flows

| Asset | Rome token | Source of truth on Solana | Bridge mechanism |
|-------|------------|----------------------------|------------------|
| USDC  | rUSDC (`SPL_ERC20`) | Circle's devnet USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | **CCTP** (native mint/burn, no wrapped tokens) |
| ETH   | rETH  (`SPL_ERC20`) | Wormhole-wrapped Sepolia-ETH mint `6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs` | **Wormhole Token Bridge** (lock-and-mint / burn-and-unlock) |

Both assets flow as SPL tokens between Solana and Ethereum. On the Rome side, an `SPL_ERC20` wrapper exposes each SPL mint as an ERC-20 so users can interact with standard wallets. The wrapper is a 1:1 view over the user's Solana ATA — there is no additional custody.

The four flows:

```
                                         Sepolia                                  Rome marcus (Solana)
                                    ┌──────────────────┐                     ┌────────────────────────┐
  Inbound CCTP   (user on Sepolia)  │  depositForBurn  │ ── IRIS attest ──►  │  receiveMessage (CPI)  │  → rUSDC minted to user ATA
  Outbound CCTP  (user on Rome)     │  receiveMessage  │ ◄── IRIS attest ──  │  burnUSDC → CCTP CPI   │  → rUSDC burned
  Inbound Wh     (user on Sepolia)  │  transferTokens  │ ── Guardian VAA ─►  │  complete_transfer_..  │  → rETH minted
  Outbound Wh    (user on Rome)     │  completeAndUnw..│ ◄── Guardian VAA ─  │  approveBurnETH+burnETH│  → rETH burned
                                    └──────────────────┘                     └────────────────────────┘
```

Attestation/VAA fetching and the return-leg submission happen off-chain in the bridge relayer (`rome-deposit-ui/src/server/bridge/`). The on-chain side is four Solana CPIs from Rome plus four Sepolia transactions.

---

## Architecture

### On Rome (this repo — `rome-solidity`)

Three bridge contracts on the `marcus` devnet EVM:

- **`SPL_ERC20`** (rUSDC, rETH) — existing wrapper. Binds an SPL mint to an ERC-20 interface. Balances, transfers, approvals, and `ensure_token_account` go through Rome's CPI precompile.
- **`RomeBridgeWithdraw`** — entrypoint for outbound flows. `burnUSDC(amount, ethRecipient)` fires a CCTP `depositForBurn` CPI. `approveBurnETH(amount)` + `burnETH(amount, ethRecipient)` (two separate EVM txs — see "Problems faced") fire an SPL Token Approve CPI then a Wormhole `transferWrapped` CPI. The contract takes all Solana program IDs, sysvars, and PDAs through its constructor so it is network-agnostic.
- **`RomeBridgePaymaster`** — ERC-2771 trusted forwarder with per-user 3-tx sponsorship cap and a `(target, selector)` allowlist. Lets the UI/frontend sponsor user gas for the bridge entrypoints (`burnUSDC`, `approveBurnETH`, `burnETH`) without the user holding rSOL.

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

### Off-chain (bridge relayer and UI — `rome-deposit-ui`)

The four flows are multi-step (source-chain tx → fetch attestation → target-chain tx). The relayer is a Next.js API server with a Redis-backed state machine:

- `src/server/bridge/flows/inboundCctp.ts` — polls Circle IRIS `/messages/{domain}/{txHash}` for the message+attestation, then submits `receiveMessage` on Solana.
- `src/server/bridge/flows/outboundCctp.ts` — looks up the Solana sig for the `burnUSDC` EVM tx via `rome_solanaTxForEvmTx`, polls IRIS for the attestation, submits `receiveMessage` on Sepolia.
- `src/server/bridge/flows/inboundWormhole.ts` — polls Wormholescan for the VAA, submits `complete_transfer_wrapped` on Solana (uses `@wormhole-foundation/sdk-solana-tokenbridge`).
- `src/server/bridge/flows/outboundWormhole.ts` — parses the Wormhole Sequence from Rome's Solana logs, polls Wormholescan for the VAA, submits `completeTransferAndUnwrapETH` on Sepolia.

The frontend (`src/features/bridge/hooks/`) handles source-chain signing and polls the relayer for completion.

---

## Current deployment (marcus devnet)

From `deployments/marcus.json`:

| Contract | Address |
|----------|---------|
| RomeBridgePaymaster | `0xcaf1fbcf60c3686d87d0a5111f340a99250ce4ef` |
| ERC20Users | `0x803f6923bcc776db1d0aa6fcdbd8ceddf35ad6f3` |
| SPL_ERC20 rUSDC | `0x6ed2944bba4cb5b1cb295541f315c648658dd67c` |
| SPL_ERC20 rETH | `0x3e52cfb38ca1639f3c95aef6dccff2b36c230f22` |
| RomeBridgeWithdraw | `0xa4c113303a3056bbb05e41f7ed539f4ca538bda7` |

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

**Why.** `SPL_MINTS_DEVNET.WETH_WORMHOLE` in `scripts/bridge/constants.ts` was set to an old test mint (`2kCwKGBvGfoY7EKHPmCwsZXamxzDMbqn1uDZMqXfve6i`) while the on-chain rETH wrapper bound to the actual canonical Wormhole-wrapped Sepolia-ETH mint (`6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs`). The deploy script derived `wrappedMeta` from the wrong mint, got a PDA that doesn't exist on chain (empty account data), and Wormhole failed when it tried to deserialize zero bytes as its `WrappedMeta` struct.

**Fix.** `SPL_MINTS_DEVNET.WETH_WORMHOLE` now points at the canonical wrapped-Sepolia-ETH mint derived via `deriveCanonicalWrappedMint({ tokenChain: 10002, tokenAddress: "eef12a83..." })`. When you redeploy the rETH wrapper, always derive the mint using `lib/canonical-mint.ts` + `lib/verify-mint-on-chain.ts` rather than hard-coding it.

**Generalize.** If a Wormhole CPI fails with "Unexpected length of input", suspect an account PDA that doesn't exist on chain long before you suspect instruction-data encoding.

### 4. Rome masks CPI errors with `CannotRevertCpi`

**Symptom.** `rome_emulateTx` and `eth_sendRawTransaction` returned generic `"execution reverted: Cannot revert cross-program invocation"` for every bridge failure, regardless of the underlying cause. No actionable info reached the client.

**Why.** Once any CPI has been attempted, Rome sets `found_cpi = true` (before executing). If the EVM then tries to revert the frame, Rome replaces the revert data with `CannotRevertCpi` (`program/src/vm/vm.rs:434`). This is intentional — the CPI's real side effects on Solana can't be rolled back — but it destroys the specific error data from the failed CPI.

**Debugging approach.** Read the proxy's stdout on the marcus host directly: `ssh -i ~/.ssh/devnet-marcus ubuntu@<marcus-ip> 'sudo docker logs proxy --tail 500 | grep -iE "mollusk|error|custom program"'`. The real Solana program error appears in the `non-evm call error: SimulateTransactionError: mollusk error: Failure(Custom(0))` line along with full Solana logs. Do this first when a CPI fails unexplained.

### 5. `block.number` on Rome EVM is the Solana slot, not stable inside a tx

**Symptom.** CCTP outbound initially used `block.number` as part of the salt for the transient `messageSentEventData` PDA. The emulator would pass one PDA; by the time the on-chain tx ran, `block.number` had changed and the program computed a different PDA → `AccountNotFound`.

**Why.** On Rome EVM, `block.number` returns the current Solana slot (`rome-evm-private/program/src/state/handler.rs: block_number() → self.slot`). Slots advance every 400ms; emulation and execution happen on different slots.

**Fix.** Per-user monotonic counter in storage (`mapping(address => uint64) burnNonce`). Stable within a tx, unique across txs. Also include `address(this)` in the salt so redeploys don't collide with PDAs used under the previous contract address. See the salt derivation at the top of `burnUSDC` / `burnETH`.

**Rule of thumb.** Never use `block.number`, `block.timestamp`, or `blockhash` in PDAs or anywhere the value has to agree between emulation and execution.

### 6. ATA creation must be idempotent when the same ATA is touched by multiple paths

**Symptom.** After an inbound Wormhole flow created the user's rETH ATA externally (via `createAssociatedTokenAccount`), subsequent Rome operations tried to create the same ATA via the non-idempotent `create` CPI and reverted with `Cannot revert CPI` — the ATA already existed.

**Fix.** `erc20spl.sol` uses `create_associated_token_account_idempotent` for the Rome-side creation. If the ATA exists, this is a no-op.

### 7. The 17-account Wormhole `transfer_wrapped` account list is tightly ordered and subtly different from `transfer_native`

**Symptom.** Multiple redeploy cycles to chase down `InvalidAccountData` errors from Wormhole — wrong number of accounts, wrong mutability flags, wrong order.

**Fix.** Derive the account list directly from the IDL. `IWormholeTokenBridge.sol: buildTransferWrappedAccounts` mirrors the account layout at `@wormhole-foundation/sdk-solana-tokenbridge: dist/esm/utils/tokenBridge/instructions/transferWrapped.js` exactly: 17 accounts (no `sender`), `from_owner` is **signer + writable**, `authority_signer` is **readonly**, `mint` is **writable**, `wormhole_core` and `token` come at the end. Before changing the layout, diff against `scripts/diff-wh-transfer-wrapped.mjs` in `rome-deposit-ui` which runs the SDK builder and prints the exact accounts Wormhole expects.

### 8. Proxy needed a new RPC method to look up Solana sigs for an EVM tx

**Symptom.** The outbound flows need to know the Solana signature of the Rome tx so the relayer can scrape Wormhole logs / poll IRIS. There was no proxy RPC for this — logs had it, but clients couldn't.

**Fix.** Added `rome_solanaTxForEvmTx(evmTxHash)` to `rome-apps/proxy/src/api/rome.rs`. It queries the `evm_tx_sol_tx` table via rome-sdk and returns an array of Solana signatures. The marcus proxy runs the `solana-tx-rpc` Docker tag which includes this method.

---

## Setup / redeploy

For a fresh deploy on a new Rome chain or to refresh marcus:

1. **Verify devnet program IDs** are live on your Solana cluster. All four (CCTP Token Messenger, CCTP Message Transmitter, Wormhole Token Bridge devnet, Wormhole Core devnet) are deployed on Solana devnet — no action needed unless you're on a different cluster.

2. **Resolve the canonical wrapped-ETH mint** for your target Ethereum network using `scripts/bridge/resolve-canonical-weth.ts`. If you are not bridging from Sepolia, update `SEPOLIA_WETH_TOKEN_CHAIN` and `SEPOLIA_WETH_TOKEN_ADDR` in `scripts/bridge/redeploy-withdraw-canonical-weth.ts` and `constants.ts`. Verify the mint exists on chain (`lib/verify-mint-on-chain.ts`).

3. **Deploy** via `scripts/bridge/deploy.ts` (full deploy) or `scripts/bridge/redeploy-withdraw-devnet-wh.ts` (keep paymaster + wrappers, refresh `RomeBridgeWithdraw`). Both scripts write `deployments/{network}.json`.

4. **Allowlist selectors on the paymaster**. The deploy scripts allowlist `burnUSDC` and `burnETH` automatically. `approveBurnETH` is allowlisted by `scripts/bridge/allowlist-approve-selector.ts` — run it after redeploy.

5. **Verify the proxy supports `rome_solanaTxForEvmTx`** for the target Rome chain. If not, the outbound Wormhole/CCTP relayer flows will not be able to find Solana sigs.

6. **Smoke test**:
   ```bash
   npx hardhat run scripts/bridge/smoke-emulate-all.ts --network marcus
   ```
   Checks that `burnUSDC` and `approveBurnETH` emulate cleanly. `burnETH` is explicitly skipped in the smoke test — it requires a prior on-chain approve.

7. **Update the frontend** (`rome-deposit-ui`) `MARCUS_WITHDRAW` address in `src/features/bridge/hooks/useOutboundWhSend.ts` and any CCTP hook file.

## Test flows end to end

- **Inbound CCTP** (Sepolia → Rome rUSDC): `scripts/bridge/inbound/01-submit-deposit.mjs` → `02-poll-attestation.mjs` → `03-submit-receive.mjs`.
- **Outbound CCTP** (Rome rUSDC → Sepolia): `scripts/bridge/submit-burn.ts` then wait for the relayer to advance the record. Or call the UI.
- **Inbound Wormhole** (Sepolia → Rome rETH): `scripts/bridge/inbound/01b-submit-whETH.mjs` → relayer advances → balance appears.
- **Outbound Wormhole** (Rome rETH → Sepolia): `scripts/bridge/submit-burnETH.ts` sends `approveBurnETH` then `burnETH`, waits for Sepolia completion.

All four have been verified E2E on marcus against Sepolia with real funds.

---

## Reading the code

Start here:

- `contracts/bridge/RomeBridgeWithdraw.sol` — entrypoint contract. The outbound side of both flows lives here. Read the NatSpec on `burnETH` / `approveBurnETH` for the split-tx rationale.
- `contracts/bridge/IWormholeTokenBridge.sol` — Wormhole account layout. The long comment on `TransferWrappedAccounts` lists the exact order and mutability; match it to the IDL before changing.
- `contracts/bridge/ICCTP.sol` — CCTP `depositForBurn` layout (17 accounts per Circle's IDL).
- `scripts/bridge/derive/wormhole-accounts.ts` — PDA derivations. `wrappedMeta` depends on the mint — keep it in sync with the deployed rETH wrapper.
- `scripts/bridge/constants.ts` — Solana program IDs (mainnet vs devnet) and SPL mints. **`SPL_MINTS_DEVNET.WETH_WORMHOLE` must match the canonical wrapped-ETH mint for the source chain you're bridging from.**

For the off-chain half, see `rome-deposit-ui/src/server/bridge/` (flows and Wormhole/CCTP helpers) and `rome-deposit-ui/src/features/bridge/` (hooks and UI).

---

## Design reference

Original spec: `docs/superpowers/specs/2026-03-12-rome-bridge-phase1-design.md`. Implementation plans: `docs/superpowers/plans/2026-03-12-rome-bridge-phase1-*.md`.
