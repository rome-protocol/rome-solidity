// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IPythLazerCache.sol";

/// @dev Slim local interface for reading the factory's owner. The cache
///      doesn't need anything else from the factory (read-side adapters
///      use IAdapterFactory.isPaused).
interface IFactoryOwnerProbe {
    function owner() external view returns (address);
}

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
    error OnlyFactoryOwner();

    event MaxStalenessUpdated(uint64 newValue);

    modifier onlyFactoryOwner() {
        if (msg.sender != IFactoryOwnerProbe(factory).owner()) revert OnlyFactoryOwner();
        _;
    }

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

    /// @notice Admin: update chain-wide staleness threshold without redeploy.
    /// @dev Gated by the factory's owner so admin uses the same governance as
    ///      the rest of OG-V2. No-op cap on relative change — emergency
    ///      tightening for MEV concerns is fast (one tx) and matches the
    ///      "no redeploy required for freshness changes" guarantee in the spec.
    function setMaxStaleness(uint64 _new) external onlyFactoryOwner {
        if (_new < 1 || _new > 24 hours) revert StalenessOutOfRange(_new);
        maxStaleness = _new;
        emit MaxStalenessUpdated(_new);
    }

    /// @notice Normalize a raw Lazer price to 8 decimals (Chainlink convention).
    /// @dev Lazer's `expo` is the negative base-10 exponent (e.g. -8 for USD-priced
    ///      crypto, -2 for FX percentages). 8-decimal normalization matches
    ///      `PythPullAdapter._normalize` exactly (`PythPullAdapter.sol:258-270`)
    ///      so Comet's `priceFeed.decimals() == PRICE_FEED_DECIMALS == 8` check
    ///      passes for drop-in usage.
    function _normalize(int64 price, int16 expo) internal pure returns (int256) {
        if (expo == -8) {
            return int256(price);
        }
        if (expo < -8) {
            // Raw has more decimals than target; scale down.
            uint256 divisor = 10 ** uint256(int256(-8) - int256(expo));
            return int256(price) / int256(divisor);
        }
        // Raw has fewer decimals than target; scale up.
        uint256 multiplier = 10 ** uint256(int256(expo) + 8);
        return int256(price) * int256(multiplier);
    }
}
