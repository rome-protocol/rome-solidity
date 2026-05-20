// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IPythLazerCache.sol";
import "./lazer/ILazerHelper.sol";

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
    error CacheLazerCallFailed();

    event MaxStalenessUpdated(uint64 newValue);
    event PriceUpdated(
        uint32 indexed feedId,
        int256 answer,
        uint64 confidence,
        uint64 timestamp,
        uint80 roundId
    );

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

    /// @notice Refresh prices from a Pyth Lazer envelope. Permissionless.
    /// @dev The caller is responsible for ensuring an Ed25519SigVerify ix
    ///      at `ed25519_ix_idx` in the same Solana tx attests to `envelope`.
    ///      Use rome-sdk's `send_with_lazer*` to construct the Solana tx;
    ///      see sibling spec for the canonical path.
    function refresh(bytes calldata envelope, uint8 ed25519_ix_idx, uint8 sig_idx) external {
        try LazerHelper.lazer_price(envelope, ed25519_ix_idx, sig_idx)
            returns (ILazerHelper.LazerFeedPrice[] memory feeds, uint64 /* publish_time_us */)
        {
            _writeFeeds(feeds);
        } catch {
            revert CacheLazerCallFailed();
        }
    }

    /// @inheritdoc IPythLazerCache
    function getPrice(uint32 feedId) external view returns (CachedPrice memory) {
        return _prices[feedId];
    }

    /// @notice Admin: update chain-wide staleness threshold without redeploy.
    /// @dev Gated by the factory's owner so admin uses the same governance as
    ///      the rest of OG-V2.
    function setMaxStaleness(uint64 _new) external onlyFactoryOwner {
        if (_new < 1 || _new > 24 hours) revert StalenessOutOfRange(_new);
        maxStaleness = _new;
        emit MaxStalenessUpdated(_new);
    }

    /// @notice Internal: write the parsed feeds to storage. Extracted from
    ///         refresh() so unit tests can exercise it via a harness without
    ///         going through the IHelperProgram precompile path.
    function _writeFeeds(ILazerHelper.LazerFeedPrice[] memory feeds) internal {
        uint64 nowTs = uint64(block.timestamp);
        for (uint i = 0; i < feeds.length; i++) {
            ILazerHelper.LazerFeedPrice memory f = feeds[i];
            CachedPrice storage c = _prices[f.feed_id];

            c.answer = _normalize(f.price, f.expo);
            // Normalize conf at the same scale as answer. Cast uint64 → int64
            // is safe because Lazer's conf is bounded well below 2^63.
            c.confidence = uint64(uint256(_normalize(int64(uint64(f.conf)), f.expo)));
            c.timestamp = nowTs;
            c.roundId = c.roundId + 1;

            emit PriceUpdated(f.feed_id, c.answer, c.confidence, c.timestamp, c.roundId);
        }
    }

    /// @notice Normalize a raw Lazer price to 8 decimals (Chainlink convention).
    /// @dev Lazer's `expo` is the negative base-10 exponent (e.g. -8 for USD-priced
    ///      crypto, -2 for FX percentages). 8-decimal normalization matches
    ///      `PythPullAdapter._normalize` exactly so Comet's
    ///      `priceFeed.decimals() == 8` check passes for drop-in usage.
    function _normalize(int64 price, int32 expo) internal pure returns (int256) {
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
