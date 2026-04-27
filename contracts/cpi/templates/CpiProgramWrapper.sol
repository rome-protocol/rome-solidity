// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CpiProgramWrapper — copy-paste scaffold for adapter golden-vector tests.
/// @notice This file is a **prose-documented scaffold**, not a functional
///         base contract. Solidity library methods can't be overridden
///         polymorphically, so a single inheritable base doesn't fit. Copy
///         the shape documented in the adjacent README (contracts/cpi/README.md
///         "Golden-vector test harness recipe" section) and drop into
///         `contracts/<yourAdapter>/<Adapter>Wrapper.sol`.
///
///   ── Purpose ──
///
///   The Kamino + Drift adapters each ship a test-only wrapper contract
///   that exposes every internal encoder / builder / discriminator-from-
///   name helper as an `external pure` function. The wrapper is deployed
///   in tests only. It lets ts-side golden-vector tests cross-check:
///
///     - The committed `bytes8 OP_DISC` constant matches
///       the Anchor discriminator computed from the instruction name.
///     - Instruction-data byte layout matches an external Borsh reference
///       fixture (JSON under `tests/fixtures/<adapter>/<op>.json`).
///     - AccountMeta[] lists match a canonical IDL fixture.
///
///   ── Scaffold shape ──
///
///   Every adapter's wrapper lands at
///   `contracts/<adapter>/<AdapterName>Wrapper.sol`. It MUST:
///
///     1. Import the adapter's core Program library + AnchorInstruction
///        + AccountMetaBuilder + any app-specific struct types.
///     2. Expose each committed `bytes8 OP_DISC` constant as an
///        `external pure` getter.
///     3. Expose each `opDiscFromName()` helper from the library as an
///        `external pure` getter so ts tests can call both sides.
///     4. Expose each `encodeOpData` and `buildOpMetas` as
///        `external pure` so ts tests can hash the bytes.
///     5. Stay free of any `onlyOwner` / `pausable` / backend-pointer
///        state — wrappers are stateless test probes, not adapters.
///
///   ── Non-goals ──
///
///   This scaffold does not provide inheritance. Copy, adapt, rename. The
///   wrapper pattern is mechanical enough that code-gen per adapter outweighs
///   the LOC savings of a polymorphic base. See rome-showcase's
///   KaminoLendProgramWrapper.sol + DriftPerpsProgramWrapper.sol for live
///   references.
contract CpiProgramWrapperScaffold {
    // This empty contract exists only to satisfy Solidity's requirement that
    // a .sol file contain a top-level declaration. The scaffold itself is the
    // NatSpec above.
}
