// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SolanaConstants
/// @notice Canonical Solana sysvar + program pubkeys for CPI plumbing.
/// @dev
///   Each constant is the bytes32 representation of the bs58-decoded Solana
///   pubkey. Tests in `tests/cpi/SolanaConstants.test.ts` bs58-decode the
///   canonical name and cross-check every value.
///
///   Maintenance: never hand-derive these. If a new program constant is
///   needed, add it here AND add a bs58 cross-check row to the test file.
///
///   Source: values copied verbatim from the three audited adapters (Meteora,
///   Kamino, Drift) that ship in rome-showcase. Per cardo-foundation.md §7
///   Task 2 "Copy bytes; don't re-derive."
library SolanaConstants {
    // ──────────────────────────────────────────────────────────────────
    // System + sysvars
    // ──────────────────────────────────────────────────────────────────

    /// 11111111111111111111111111111111 — all-zero pubkey.
    bytes32 internal constant SYSTEM_PROGRAM = bytes32(0);

    /// SysvarRent111111111111111111111111111111111.
    bytes32 internal constant SYSVAR_RENT =
        0x06a7d517192c5c51218cc94c3d4af17f58daee089ba1fd44e3dbd98a00000000;

    /// Sysvar1nstructions1111111111111111111111111.
    bytes32 internal constant SYSVAR_INSTRUCTIONS =
        0x06a7d517187bd16635dad40455fdc2c0c124c68f215675a5dbbacb5f08000000;

    /// SysvarC1ock11111111111111111111111111111111.
    bytes32 internal constant SYSVAR_CLOCK =
        0x06a7d51718c774c928566398691d5eb68b5eb8a39b4b6d5c73555b2100000000;

    // ──────────────────────────────────────────────────────────────────
    // Token programs
    // ──────────────────────────────────────────────────────────────────

    /// TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA — classic SPL Token.
    bytes32 internal constant SPL_TOKEN_PROGRAM =
        0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9;

    /// ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL — Associated Token.
    bytes32 internal constant ASSOCIATED_TOKEN_PROGRAM =
        0x8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859;

    /// TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb — Token-2022.
    /// Forward-compatible; no current adapter uses Token-2022 extensions.
    bytes32 internal constant TOKEN_2022_PROGRAM =
        0x06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc;
}
