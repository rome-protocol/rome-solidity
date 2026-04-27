# Cardo CPI Foundation

Shared library + templates every Cardo app adapter is built on top of.

Lives at `rome-solidity/contracts/cpi/`. Imported by each adapter in
`rome-showcase/contracts/<adapter>/`.

See the canonical spec: `rome-specs/active/technical/cardo-foundation.md`.

---

## 1. The three-layer pattern

Every Cardo adapter is three files plus a mock:

| Layer | File | Role |
|---|---|---|
| **Interface** | `contracts/interfaces/I<Adapter>.sol` | Public ABI users + UI consume. One method per capability + `quoteCost`. |
| **Mock** | `contracts/mocks/Mock<Adapter>.sol` | Test-only stand-in implementing the interface without CPI. Used by Cardo-app unit tests. |
| **Backend (CpiBackend)** | `contracts/<adapter>/<Adapter>CpiBackend.sol` *(3-layer adapters only — Kamino, Drift)* | Encapsulates CPI calls. Takes an explicit `address user`; never reads `tx.origin`. |
| **Adapter** | `contracts/<adapter>/<Adapter>Adapter.sol` | User-facing entry point. Extends `CpiAdapterBase`. Captures `msg.sender`, passes it to the backend. Implements `ICostView.quoteCost`. |

Two-layer adapters (Meteora) fold the backend into the adapter file; still
use `UserPda.pda(msg.sender)` — no tx.origin.

---

## 2. Copy-paste skeleton

```solidity
// contracts/<adapter>/<Adapter>Adapter.sol
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CpiAdapterBase} from "rome-solidity/contracts/cpi/templates/CpiAdapterBase.sol";
import {CostEstimate} from "rome-solidity/contracts/cpi/CostEstimate.sol";
import {ICostView} from "rome-solidity/contracts/cpi/ICostView.sol";
import {UserPda} from "rome-solidity/contracts/cpi/UserPda.sol";
import {I<Adapter>} from "../interfaces/I<Adapter>.sol";
import {I<Adapter>Backend} from "./I<Adapter>Backend.sol";

contract <Adapter>Adapter is CpiAdapterBase, ICostView, I<Adapter> {
    I<Adapter>Backend public immutable impl;

    constructor(address owner_, I<Adapter>Backend impl_) CpiAdapterBase(owner_) {
        impl = impl_;
    }

    // Capability — captures msg.sender; backend receives explicit user arg.
    function <capability>(/* args */) external whenNotPaused nonReentrant {
        impl.<capability>(msg.sender, /* args */);
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

```solidity
// contracts/<adapter>/<Adapter>CpiBackend.sol
import {Cpi} from "rome-solidity/contracts/cpi/Cpi.sol";
import {UserPda} from "rome-solidity/contracts/cpi/UserPda.sol";
import {AccountMetaBuilder} from "rome-solidity/contracts/cpi/AccountMetaBuilder.sol";
import {AnchorInstruction} from "rome-solidity/contracts/cpi/AnchorInstruction.sol";

contract <Adapter>CpiBackend is I<Adapter>Backend {
    function <capability>(address user, /* args */) external override {
        bytes32 userKey = UserPda.pda(user);   // never tx.origin

        AccountMetaBuilder.Meta memory m = AccountMetaBuilder.alloc(N);
        AccountMetaBuilder.signer(m, userKey);
        AccountMetaBuilder.writable(m, /* ... */);
        // ... remaining slots ...

        bytes memory data = AnchorInstruction.withDisc(
            OP_DISC,
            abi.encodePacked(AnchorInstruction.u64le(amount))
        );

        Cpi.invoke(PROGRAM_ID, AccountMetaBuilder.build(m), data);
    }
}
```

---

## 3. Call-graph

```
         ┌────────────┐
         │ msg.sender │
         └─────┬──────┘
               │ (user signs tx)
               ▼
      ┌─────────────────┐
      │ <Adapter>       │  ← extends CpiAdapterBase
      │ Adapter.sol     │    (Ownable+Pausable+ReentrancyGuard)
      └────────┬────────┘
               │ impl.<capability>(msg.sender, args)
               ▼
      ┌─────────────────┐
      │ <Adapter>       │  ← called with explicit address user
      │ CpiBackend.sol  │    (no tx.origin path)
      └────────┬────────┘
               │ Cpi.invoke(program, metas, data)
               ▼
      ┌─────────────────┐
      │ CPI precompile  │  0xFF00000000000000000000000000000000000008
      │ (0xFF…08)       │
      └─────────────────┘
```

In tests, the Adapter is instantiated with a `MockBackend` that implements
the same interface without CPI. The call-graph ends at the mock.

---

## 4. `tx.origin` vs `msg.sender`

**Every backend MUST take an explicit `address user` argument.** The adapter
captures `msg.sender` and passes it to the backend.

Never call `UserPda.pda(tx.origin)`. Never call `RomeEVMAccount.pda(tx.origin)`.
The CI grep rule in `.github/workflows/ci.yml` fails the build on any
`\btx\.origin\b` match inside `contracts/`.

Meteora (2-layer) still applies the rule: it takes a `to` arg
(authenticated via `msg.sender` check) and derives the PDA from `to`.

See cardo-foundation.md §9 for the full rationale and the SECURITY.md
disclosure language every refactor PR must include.

---

## 5. `invoke` vs `invokeSigned`

| Function | When to use |
|---|---|
| `Cpi.invoke` | Default. The precompile derives the signer from the caller's Rome PDA automatically. |
| `Cpi.invokeSigned` | When the Solana program needs an explicit salt-derived signer (e.g. Meteora's payer PDA for pool-creation rent). Pass seeds as `bytes32[]`. |

---

## 6. Account-meta flag cheatsheet

| Builder method | `is_signer` | `is_writable` | Typical use |
|---|---|---|---|
| `signer(key)` | true | false | User's Rome PDA (authority only) |
| `writable(key)` | false | true | Reserve / obligation / user ATA |
| `readonly(key)` | false | false | Program IDs, pool config, sysvar |
| `signerWritable(key)` | true | true | Payer account (Drift `init_user` funding) |

Rule of thumb: if the Solana instruction mutates the account OR uses it as a
program-supplied rent payer, flag `is_writable`. If the instruction requires
the account to have signed this tx at all (PDA or wallet), flag `is_signer`.

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

See `rome-showcase/contracts/kamino/KaminoLendProgramWrapper.sol` for a live
reference.

---

## 8. Cost quote checklist

Every capability MUST populate every `CostEstimate` field unless there is a
comment explaining why it's zero. Required fields (per cardo-foundation §4.3):

- `evmGasEstimate` — Cardo UI stitches this from `rome-evm-client`'s
  `estimate_gas`; adapter returns a placeholder. Document the placeholder
  in the adapter's SECURITY.md.
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

Every new capability goes through the budget gate before implementation:

| Budget | Ceiling | Verified by |
|---|---|---|
| Single CPI CU | ≤ 1.0M (leaves 400k for Rome's EVM prologue) | Devnet dry-run, capture from Proxy |
| Account count | ≤ 24 (leaves margin under Solana's 32-account ceiling) | Sum IDL account array |
| Solana tx size | ≤ 1000 bytes (leaves ~200 for Rome's DoTx prologue) | 8 (disc) + args + 34 × accounts |

See `rome-specs/active/technical/app-distribution-portal-m2-showcase-contracts.md §0`
for the recon template.

---

## 10. Non-goals

See cardo-foundation.md §12 for the full list. Highlights:

- **No IDL codegen** — hand-write discriminators + account order per adapter.
- **No generic CPI simulator** — devnet empirical measurement.
- **No protocol-specific fee model in the foundation** — adapters own fee reads.
- **No Mock testing framework** — per-adapter Mock classes.
- **No server-side `quoteCost` caching** — helpers do live oracle reads; any
  cache beyond request-scope can serve quotes past the adapter's staleness
  window. See cardo-foundation.md §4.4.

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
| `PdaDeriver.sol` | `find_program_address` + typed seed helpers + N-arg makeSeeds |
| `SolanaConstants.sol` | Sysvars + System/Token programs |
| `UserPda.sol` | EVM user → Solana PDA + ATA (no tx.origin) |
| `templates/CpiAdapterBase.sol` | Ownable + Pausable + ReentrancyGuard + backend |
| `templates/CpiProgramWrapper.sol` | Prose scaffold for golden-vector wrappers |
