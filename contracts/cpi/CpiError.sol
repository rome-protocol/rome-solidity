// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CpiError
/// @notice Shared error selectors for Cardo CPI adapters.
/// @dev
///   Centralises the 4 most-copied error signatures across Meteora / Kamino /
///   Drift. Adapters `import {CpiError} from "..."` and `revert
///   CpiError.AmountTooLarge(x)` rather than declaring their own local copies.
///
///   Adding new shared errors: each addition must preserve selector stability
///   for existing adapters. Do not rename or reorder parameters. If an
///   adapter needs an app-specific error (e.g. `UnsupportedPlaceParams` in
///   Drift), declare it locally — the foundation only owns errors reused by
///   3+ adapters.
library CpiError {
    /// Thrown when a uint256 / int256 input cannot be downcast to u64/i64
    /// at the Solidity ↔ Solana boundary. Solana's native integer types
    /// cap at 64 bits; adapters must validate before encoding.
    error AmountTooLarge(uint256 amount);

    /// Thrown when an authentication check (msg.sender vs a stored
    /// expected signer, e.g. backend's allowlisted adapter address) fails.
    error SignerMismatch(address expected, address actual);

    /// Thrown when an `AccountMeta[]` is built at an unexpected length. The
    /// fluent builder in AccountMetaBuilder enforces this on `.build()`.
    error InvalidAccountCount(uint256 got, uint256 want);

    /// Thrown when a CPI-adjacent entry point is called by an unauthorised
    /// caller (generic catch-all — adapters should prefer `SignerMismatch`
    /// with the expected address when possible).
    error CpiUnauthorized();
}
