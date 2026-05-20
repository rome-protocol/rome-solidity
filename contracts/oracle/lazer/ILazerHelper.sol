// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ILazerHelper
/// @notice Lazer-specific slice of Rome's HelperProgram precompile surface.
///         Self-contained — the OG-V2 Lazer adapter family (cache, per-feed
///         adapters) imports ONLY from this file, not from the global
///         `contracts/interface.sol`. Keeps Lazer-side evolution decoupled
///         from the rest of Rome's precompile surface.
///
/// Source of truth for the on-chain ABI:
///   rome-evm-private/program/src/non_evm/lazer_ix.rs (selector 0xa5f15a86)
///
/// Spec: rome-specs/active/technical/2026-05-20-og-v2-pyth-lazer-adapter.md §3
interface ILazerHelper {
    /// @notice Per-feed price returned by the on-chain Lazer wrapper.
    ///         `price` and `conf` are signed/unsigned int64 in Lazer's wire
    ///         format; `expo` is the negative base-10 exponent (e.g. -8 for
    ///         USD-priced crypto). Callers normalize via `_normalize` at
    ///         write time so storage carries Chainlink-compatible 8-decimal
    ///         answers.
    struct LazerFeedPrice {
        uint32 feed_id;
        int64  price;
        uint64 conf;
        int32  expo;
    }

    /// @notice Verify a Pyth Lazer signed envelope and return its parsed feeds.
    /// @dev The caller MUST ensure an Ed25519SigVerify ix at `ed25519_ix_idx`
    ///      in the same Solana tx attests to `envelope` bytes. The Rome SDK's
    ///      `send_with_lazer*` constructs this Solana tx correctly; see
    ///      sibling spec 2026-05-20-rome-sdk-lazer-productization.md.
    /// @param envelope Pyth Lazer SolanaMessage envelope bytes.
    /// @param ed25519_ix_idx Index of the Ed25519SigVerify ix in the current Solana tx.
    /// @param sig_idx Which signature within the Ed25519 ix to check.
    /// @return feeds Array of LazerFeedPrice — one per publishing feed.
    /// @return publish_time_us Envelope-level publish timestamp (microseconds).
    function lazer_price(
        bytes calldata envelope,
        uint8 ed25519_ix_idx,
        uint8 sig_idx
    ) external view returns (LazerFeedPrice[] memory feeds, uint64 publish_time_us);
}

// Pre-bound LazerHelper at the Rome HelperProgram precompile address.
// Source of truth: rome-evm-private/program/src/non_evm/helper.rs.
ILazerHelper constant LazerHelper = ILazerHelper(0xff00000000000000000000000000000000000009);
