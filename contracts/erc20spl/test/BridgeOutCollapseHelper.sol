// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title BridgeOutCollapseHelper
/// @notice Pure-Solidity mirror of the post-collapse `SPL_ERC20.
///         bridgeOutToSolana` validation + predicates. The actual ATA-
///         create + SPL transfer CPIs need a live Rome chain to exercise;
///         this pins the input validation + the predicates used to
///         conditionally skip the ATA-create when one already exists.
///
/// ## What this mirror covers (FB-5)
///
///   - Recipient pubkey validation (non-zero).
///   - Value cap (u64.max).
///   - `recipientNeedsAta` predicate: TRUE iff observed lamports == 0
///     (= ATA missing on Solana, idempotent create is a net new account).
///
/// ## What this mirror deliberately does NOT cover
///
///   - The CPI itself — needs a live chain.
///   - The `CreateIdempotent` instruction semantics — those are tested
///     on-chain via the bridgeOutToSolana integration suite once a chain
///     is up. On-chain idempotency is enforced by the Associated Token
///     Program itself, not by Rome.
contract BridgeOutCollapseHelper {
    /// Mirror of the input-validation gate at the top of
    /// `bridgeOutToSolana(bytes32 solana_recipient, uint256 value)`.
    ///
    /// @return true iff the inputs would pass `require(value <= u64.max)`
    ///         AND `require(solana_recipient != bytes32(0))`.
    function validateBridgeOutInputs(bytes32 recipient, uint256 value)
        external
        pure
        returns (bool)
    {
        if (recipient == bytes32(0)) {
            return false;
        }
        if (value > type(uint64).max) {
            return false;
        }
        return true;
    }

    /// Mirror of the `recipientNeedsAta` predicate used by the collapsed
    /// `bridgeOutToSolana` to decide whether to fire the ATA-create CPI
    /// at all (saving the CPI when the recipient ATA already exists).
    ///
    /// The real path either skips the CPI (lamports > 0 → ATA exists),
    /// or fires `AssociatedToken.CreateIdempotent` (lamports == 0 →
    /// account needs creating; idempotent so concurrent creates are
    /// race-safe).
    ///
    /// Note: even with this short-circuit, the CreateIdempotent CPI is
    /// safe to ALWAYS fire — it no-ops on the Solana side when the
    /// account already exists. The skip is purely a CU optimization;
    /// callers shouldn't rely on the skip for correctness.
    function recipientNeedsAta(uint64 observedAtaLamports)
        external
        pure
        returns (bool)
    {
        return observedAtaLamports == 0;
    }
}
