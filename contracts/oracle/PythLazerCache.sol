// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IPythLazerCache.sol";

/// @title PythLazerCache
/// @notice Singleton shared cache for Pyth Lazer prices on a Rome chain.
///         One cache per chain; many `PythLazerFeedAdapter` clones read from it.
///         Spec: rome-specs/active/technical/2026-05-20-og-v2-pyth-lazer-adapter.md §3.2
///
/// Permissionless `refresh(envelope, ed25519_ix_idx, sig_idx)` writes all
/// feeds in the envelope. The on-chain Lazer wrapper at HelperProgram
/// (`0xff..09`) verifies the Pyth signature via the prepended Ed25519SigVerify
/// ix. Callers (foundation keeper, atomic-flow composers) construct the
/// Solana tx via rome-sdk's `send_with_lazer*` — see sibling spec
/// `2026-05-20-rome-sdk-lazer-productization.md`.
contract PythLazerCache is IPythLazerCache {
    /// @notice Chain-wide staleness threshold in seconds. One value covers all
    ///         feeds in this cache. Adapters read this via `IPythLazerCache.maxStaleness`.
    uint64 public maxStaleness;

    /// @notice Owner-gating source — defers to the factory's `owner()` so
    ///         emergency staleness tightening uses the same governance path
    ///         as the rest of OG-V2.
    address public immutable factory;

    /// @notice Per-feed cached price records. Storage default = zero struct
    ///         (timestamp == 0 signals cold-start; adapters revert with their
    ///         own `UninitializedPriceFeed` rather than `StalePriceFeed`).
    mapping(uint32 feedId => CachedPrice) private _prices;

    error StalenessOutOfRange(uint64 staleness);

    constructor(address _factory, uint64 _maxStaleness) {
        if (_maxStaleness < 1 || _maxStaleness > 24 hours) {
            revert StalenessOutOfRange(_maxStaleness);
        }
        factory = _factory;
        maxStaleness = _maxStaleness;
    }

    /// @inheritdoc IPythLazerCache
    function getPrice(uint32 feedId) external view returns (CachedPrice memory) {
        return _prices[feedId];
    }
}
