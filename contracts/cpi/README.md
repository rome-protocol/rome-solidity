# CPI foundation

Shared library and templates for Solidity contracts that call Solana programs
through the CPI precompile (`0xFF00000000000000000000000000000000000008`).

Lives at `rome-solidity/contracts/cpi/`. A contract that wants to call a Solana
program imports these files.

**Who signs.** A contract that calls the precompile signs as itself: the signer
is the contract's own Solana authority, `HelperProgram.pda(address(this))`, plus
one salted sub-PDA per salt the contract passes to `invoke_signed`. The user's
own authority never signs a CPI made by a contract, and a contract cannot sign
for it. A user's rights over their tokens reach the contract as an SPL
delegation the user grants first (section 2), not as a signature.

---

## 1. The adapter pattern

A contract that fronts a Solana program is an interface, an adapter and a mock:

| Layer | File | Role |
|---|---|---|
| **Interface** | `contracts/interfaces/I<Adapter>.sol` | Public ABI users and the UI consume. One method per capability + `quoteCost`. |
| **Mock** | `contracts/mocks/Mock<Adapter>.sol` | Test-only stand-in implementing the interface without CPI. |
| **Adapter** | `contracts/<adapter>/<Adapter>Adapter.sol` | User-facing entry point. Extends `CpiAdapterBase`. Makes the CPI itself, so **its own authority is the signer**. Implements `ICostView.quoteCost`. |
| **Backend** *(optional)* | `contracts/<adapter>/<Adapter>CpiBackend.sol` | A separate contract the adapter calls to make the CPI. The signer is then the **backend's** authority, and the backend's token accounts hold the funds, not the adapter's. Use this split only when you want a rotatable CPI contract. |

Whichever contract calls the precompile is the one that signs and the one that
owns the token accounts your Solana program spends from.

---

## 2. Copy-paste skeleton

Tokens reach the adapter through an SPL delegation. Before the call (or each
run of calls) the user sends `approve_spl(adapter, amount, mint)` as a transaction straight to the
HelperProgram precompile (`0xFF00000000000000000000000000000000000009`), which
makes the adapter's authority the SPL delegate on the user's token account. The
adapter then pulls with the delegate overload of `HelperProgram.transfer_spl`
and calls the Solana program as itself.

Do not fund an adapter with an ERC-20 `transferFrom` on the SPL wrapper. For a
contract recipient the wrapper moves the tokens into its own escrow token
account and only records the amount for the contract (`balanceOf(contract)` is
that record), so the adapter ends up with no token account it can spend from.

```solidity
// contracts/<adapter>/<Adapter>Adapter.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CpiAdapterBase} from "rome-solidity/contracts/cpi/templates/CpiAdapterBase.sol";
import {Cpi} from "rome-solidity/contracts/cpi/Cpi.sol";
import {AccountMetaBuilder} from "rome-solidity/contracts/cpi/AccountMetaBuilder.sol";
import {AnchorInstruction} from "rome-solidity/contracts/cpi/AnchorInstruction.sol";
import {CostEstimate} from "rome-solidity/contracts/cpi/CostEstimate.sol";
import {ICostView} from "rome-solidity/contracts/cpi/ICostView.sol";
import {HelperProgram} from "rome-solidity/contracts/interface.sol";
import {I<Adapter>} from "../interfaces/I<Adapter>.sol";

contract <Adapter>Adapter is CpiAdapterBase, ICostView, I<Adapter> {
    bytes32 public immutable mint;      // the SPL mint the capability moves

    constructor(address owner_, bytes32 mint_) CpiAdapterBase(owner_) {
        mint = mint_;
        HelperProgram.create_pda(address(this));         // the adapter's own Solana identity
        HelperProgram.create_ata(address(this), mint_);  // a token account it owns
    }

    // Capability: pull from the user (they granted the SPL delegate), then CPI as the adapter.
    function <capability>(uint64 amount) external whenNotPaused nonReentrant {
        bytes32 self       = HelperProgram.pda(address(this));          // the signer
        bytes32 adapterAta = HelperProgram.ata(address(this), mint);

        // Legacy-track pull; the adapter's authority signs as the user's SPL delegate.
        HelperProgram.transfer_spl(HelperProgram.ata(msg.sender, mint), adapterAta, amount, mint);

        AccountMetaBuilder.Meta memory m = AccountMetaBuilder.alloc(N);
        AccountMetaBuilder.signerWritable(m, self);          // the adapter's authority, never the user's
        AccountMetaBuilder.writable(m, adapterAta);           // source: owned by the adapter's authority
        AccountMetaBuilder.writable(m, /* ... */);
        // ... remaining slots ...

        bytes memory data = AnchorInstruction.withDisc(
            OP_DISC,
            abi.encodePacked(AnchorInstruction.u64le(amount))
        );

        Cpi.invoke(PROGRAM_ID, AccountMetaBuilder.build(m), data);
    }

    function quoteCost(address user, bytes calldata capabilityInputs)
        external view override returns (CostEstimate memory)
    {
        (bytes4 selector, bytes memory args) = abi.decode(capabilityInputs, (bytes4, bytes));
        if (selector == this.<capability>.selector) return _quote<Cap>(user, args);
        revert UnknownCapability(selector);
    }
}
```

When the Solana program wants one owner account per user, use
`Cpi.invokeSigned` with one salt per user (for example the user's address as a
`bytes32`) and mark `HelperProgram.pda_with_salt(address(this), salt)` as a
signer in the account list. Every salt you pass must appear in the account list
as a signer, or the call fails with `signer account calculated from the provided
seed was not found`.

Two consequences for the user:

- **A token account has one delegate.** The grant to the adapter replaces the
  grant the SPL wrapper holds on the same account. Until the user grants the
  wrapper again (`approve_spl(wrapper, 2^64-1, mint)` to the HelperProgram, the maximum grant the wrapper is built around), the
  user's `transfer` and `transferFrom` on that wrapper revert with SPL error
  `0x4`. After the flow, check the wrapper's `isEnabled(user)` and prompt the
  user to re-grant when it is `false`. The re-grant in turn removes the adapter's
  delegation, so the next call needs a new `approve_spl(adapter, ...)`.
- **One track per transaction.** `HelperProgram.transfer_spl` and `Cpi.invoke`
  are both legacy-track, so they share a transaction. Do not call the cached SPL
  wrapper's mutating functions in the same transaction as a legacy CPI.

---

## 3. Call-graph

```
         ┌────────────┐
         │ msg.sender │   (user: signs the EVM tx; granted the adapter an SPL delegate)
         └─────┬──────┘
               ▼
      ┌─────────────────┐
      │ <Adapter>       │  ← extends CpiAdapterBase
      │ Adapter.sol     │    (Ownable+Pausable+ReentrancyGuard)
      └────────┬────────┘
               │ HelperProgram.transfer_spl(userAta, adapterAta, ...)   (spends the delegation)
               │ Cpi.invoke / invokeSigned(program, metas, data)
               ▼
      ┌─────────────────┐
      │ CPI precompile  │  0xFF00000000000000000000000000000000000008
      │ (0xFF…08)       │  signs as external_auth(<Adapter>), plus any salted sub-PDAs
      └─────────────────┘
```

In tests, the adapter is instantiated against a mock that implements the same
interface without CPI. The call-graph ends at the mock.

---

## 4. The user is never the signer

The signer of a CPI is whoever calls the precompile, and that is the contract.
Never mark `UserPda.pda(user)` (the user's authority) as a signer in an account
list: Rome gives it no signer seed, and the Solana runtime refuses the CPI. A
contract cannot move a user's assets by signing for them; it needs the user's
SPL delegation first (section 2).

Use the user's address for what it is good for: keying a position (as a salt),
deriving the user's ATA to pay out to (`UserPda.ata(user, mint)`), and reading
balances. Take it from `msg.sender`.

Never derive anything from `tx.origin`. The CI job `tx-origin-ban` fails the
build on any `tx.origin` on a non-comment line of a `.sol` file under
`contracts/`, because a contract
that acts on `tx.origin` can be driven by any contract the user calls.

---

## 5. `invoke` vs `invokeSigned`

Both sign as the calling contract's bare authority when
`HelperProgram.pda(address(this))` is listed in the account metas as a signer.
Only `invokeSigned` can also sign for salted sub-PDAs.

| Function | When to use |
|---|---|
| `Cpi.invoke` | Default. The contract's own authority is the only signer you need. |
| `Cpi.invokeSigned` | When the Solana program needs a salted sub-PDA as a signer too (a per-user owner account, or a payer PDA for pool-creation rent). Pass the salts as `bytes32[]`; each one must be listed as a signer in the metas. |

Under `DELEGATECALL` the precompile refuses the bare authority
(`DelegatecallOwnerAuthority`) and namespaces salted PDAs by the running
contract's address, so do not make CPIs from a delegatecalled library.

---

## 6. Account-meta flag cheatsheet

| Builder method | `is_signer` | `is_writable` | Typical use |
|---|---|---|---|
| `signer(key)` | true | false | The contract's own authority or a salted sub-PDA of it (authority only) |
| `writable(key)` | false | true | Reserve / obligation / the contract's ATA / a user ATA you pay out to |
| `readonly(key)` | false | false | Program IDs, pool config, sysvar |
| `signerWritable(key)` | true | true | The contract's authority when it also funds or is debited by the instruction (for example as payer or token owner) |

Rule of thumb: if the Solana instruction mutates the account OR uses it as a
program-supplied rent payer, flag `is_writable`. If the instruction requires
the account to have signed, flag `is_signer`. The only accounts Rome can sign
are the calling contract's authority and its salted sub-PDAs; a wallet or a
user's authority cannot be a signer in a contract's CPI.

---

## 7. Golden-vector test harness recipe

Each adapter ships a test-only wrapper exposing every internal encoder:

```solidity
// contracts/<adapter>/<Adapter>Wrapper.sol
import {<Adapter>Lib} from "./<Adapter>Lib.sol";

contract <Adapter>Wrapper {
    function depositDisc() external pure returns (bytes8) {
        return <Adapter>Lib.DEPOSIT_DISC;
    }
    function depositDiscFromName() external pure returns (bytes8) {
        return <Adapter>Lib.depositDiscFromName();  // sha256("global:deposit")[..8]
    }
    function encodeDepositData(uint64 amt) external pure returns (bytes memory) {
        return <Adapter>Lib.encodeDepositData(amt);
    }
}
```

Ts test asserts:

```ts
assert.equal(await wrapper.read.depositDisc(), await wrapper.read.depositDiscFromName());
assert.equal(await wrapper.read.encodeDepositData([1000n]), EXPECTED_BYTES);
```

See `templates/CpiProgramWrapper.sol` for the scaffold.

---

## 8. Cost quote checklist

Every capability MUST populate every `CostEstimate` field unless there is a
comment explaining why it's zero. Required fields:

- `evmGasEstimate` — the UI fills this in from the node's `eth_estimateGas`;
  the adapter returns a placeholder. Document the placeholder in the adapter's
  SECURITY.md.
- `solanaCuEstimate` — adapter constant, measured on devnet, refreshed per PR.
  Use a `uint64 constant CU_<OP> = <value>; // recon YYYY-MM-DD, <net>`.
- `rentRequired[]` — enumerate every account the capability touches. Use
  `CostEstimator.ataExists` / `pdaExists` to set `alreadyExists`.
- `fees[]` — adapter reads pool / reserve / market state. Use
  `ProtocolFee { protocol: keccak("<name>"), amountIn, feeBps, feeAmount }`.
- `output` — for output-producing capabilities, `tokenErc20Spl` + nonzero
  `expectedAmount` + `minAmount`. For non-output ops (borrow / repay /
  deposit / cancel), all zero.
- `totalUserCostUsd` — roll up via `CostEstimator.usdValue` +
  `CostEstimator.evmGasUsd`; append adapter addresses to the
  caller-supplied `ReadsBuffer` as you go.
- `oracleReads[]` — finalise via `CostEstimator.finalizeReads(buf)`. The UI
  re-checks each adapter's `getFeedHealth` before the user signs.

---

## 9. CU / account-count / tx-size budget

An atomic Rome transaction is one Solana v1 transaction: about 1.4M compute
units, 64 addresses and 4 KB on the wire (see the Constraints page in the Rome
docs). Rome's own program, the wrapper and your CPI share that budget, and the 64
addresses include Rome's accounts for the user and the contract. Every new
capability goes through this gate before implementation:

| Budget | Ceiling | Verified by |
|---|---|---|
| Compute units, whole transaction | ~1.4M, shared with Rome's program and any token movement | Devnet dry-run; read `computeUnitsConsumed` from the Solana receipt |
| Addresses | 64 for the whole transaction (the CPI's accounts, the token accounts, Rome's accounts) | Count the metas plus the accounts the emulation reports |
| Transaction size | 4 KB | The proxy stages anything larger; a transaction that no longer fits one atomic leg runs iteratively, and a legacy CPI then fails |

A transaction that goes iterative cannot carry a legacy-track CPI
(`CpiProhibitedInIterativeTx`), so keep each capability to one token movement
plus one CPI.

---

## 10. Non-goals

- **No IDL codegen** — hand-write discriminators + account order per adapter.
- **No generic CPI simulator** — devnet empirical measurement.
- **No protocol-specific fee model in the foundation** — adapters own fee reads.
- **No Mock testing framework** — per-adapter Mock classes.
- **No server-side `quoteCost` caching** — helpers do live oracle reads; any
  cache beyond request-scope can serve quotes past the adapter's staleness
  window.

---

## 11. Foundation file reference

| File | Role |
|---|---|
| `AccountMetaBuilder.sol` | Fluent `AccountMeta[]` builder |
| `AnchorInstruction.sol` | Discriminator + Borsh LE primitives + Option<T> |
| `Cpi.sol` | invoke / invokeSigned / accountInfo wrappers |
| `CostEstimate.sol` | Uniform quote struct types |
| `CostEstimator.sol` | Rent formula + USD helpers + oracleReads audit trail |
| `CpiError.sol` | AmountTooLarge + 3 other shared errors |
| `ICostView.sol` | `quoteCost(address, bytes) view → CostEstimate` |
| `PdaDeriver.sol` | `find_program_address` + typed seed helpers + N-arg makeSeeds (single PDA via `0xFF…07`) |
| `PdasBatch.sol` | `pdas_batch_derive` wrapper — N PDAs against one program in one syscall (`0xFF…08` / `0x944336f8`). Use over N×`PdaDeriver.derive` whenever you derive ≥2 PDAs back-to-back. Convenience: `pair` / `triplet` / `quad` for common shapes. Worked example: `contracts/examples/pdas_batch.sol`. |
| `SolanaConstants.sol` | Sysvars + System/Token programs |
| `UserPda.sol` | EVM user → Solana PDA + ATA (no tx.origin) |
| `templates/CpiAdapterBase.sol` | Ownable + Pausable + ReentrancyGuard + backend |
| `templates/CpiProgramWrapper.sol` | Prose scaffold for golden-vector wrappers |
