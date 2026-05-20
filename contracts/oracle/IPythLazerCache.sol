// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IPythLazerCache
/// @notice Interface for the singleton Pyth Lazer price cache.
///         Adapters read from this cache via `getPrice` + `maxStaleness`.
///         Spec: rome-specs/active/technical/2026-05-20-og-v2-pyth-lazer-adapter.md
interface IPythLazerCache {
    /// @notice Cached price record per feed.
    ///         `answer` and `confidence` are both normalized to 8 decimals
    ///         (Chainlink convention). `timestamp` is unix seconds at refresh.
    ///         `roundId` is monotonic per feed.
    struct CachedPrice {
        int256 answer;
        uint64 confidence;
        uint64 timestamp;
        uint80 roundId;
    }

    /// @notice Read the latest cached price for a feed.
    /// @param feedId Pyth Lazer feed id (uint32 in Pyth's wire format).
    /// @return The cached price record. If the feed has never been refreshed,
    ///         the struct's `timestamp == 0` and adapters should revert with
    ///         their own `UninitializedPriceFeed`.
    function getPrice(uint32 feedId) external view returns (CachedPrice memory);

    /// @notice Chain-wide staleness threshold in seconds. One value covers
    ///         all feeds in this cache. Adapters read this to enforce
    ///         freshness on every `latestRoundData()` call.
    function maxStaleness() external view returns (uint64);
}
