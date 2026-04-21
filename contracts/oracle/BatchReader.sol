// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IAggregatorV3Interface.sol";
import "./IAdapterFactory.sol";
import "./IAdapterMetadata.sol";

/// @title BatchReader
/// @notice Stateless contract for reading multiple oracle feeds in one call.
///         Uses try/catch so one stale/paused feed doesn't revert the batch.
contract BatchReader {
    struct PriceResult {
        address adapter;
        int256 answer;
        uint256 updatedAt;
        bool success;
    }

    struct FeedHealth {
        address adapter;
        bool isHealthy;             // fresh && !paused && price > 0
        bool isStale;
        bool isPaused;
        uint256 lastUpdate;
        int256 latestPrice;
        uint256 secondsSinceUpdate;
    }

    /// @notice Read latest prices from multiple adapters
    /// @param adapters Array of adapter addresses
    /// @return results Array of price results (failed reads have success=false)
    function getLatestPrices(address[] calldata adapters)
        external
        view
        returns (PriceResult[] memory results)
    {
        results = new PriceResult[](adapters.length);

        for (uint256 i = 0; i < adapters.length; i++) {
            results[i].adapter = adapters[i];
            try IAggregatorV3Interface(adapters[i]).latestRoundData() returns (
                uint80,
                int256 answer,
                uint256,
                uint256 updatedAt,
                uint80
            ) {
                results[i].answer = answer;
                results[i].updatedAt = updatedAt;
                results[i].success = true;
            } catch {
                results[i].success = false;
            }
        }
    }

    /// @notice Read full round data from multiple adapters
    function getLatestRoundDataBatch(address[] calldata adapters)
        external
        view
        returns (
            uint80[] memory roundIds,
            int256[] memory answers,
            uint256[] memory startedAts,
            uint256[] memory updatedAts,
            uint80[] memory answeredInRounds,
            bool[] memory successes
        )
    {
        uint256 len = adapters.length;
        roundIds = new uint80[](len);
        answers = new int256[](len);
        startedAts = new uint256[](len);
        updatedAts = new uint256[](len);
        answeredInRounds = new uint80[](len);
        successes = new bool[](len);

        for (uint256 i = 0; i < len; i++) {
            try IAggregatorV3Interface(adapters[i]).latestRoundData() returns (
                uint80 roundId,
                int256 answer,
                uint256 startedAt,
                uint256 updatedAt,
                uint80 answeredInRound
            ) {
                roundIds[i] = roundId;
                answers[i] = answer;
                startedAts[i] = startedAt;
                updatedAts[i] = updatedAt;
                answeredInRounds[i] = answeredInRound;
                successes[i] = true;
            } catch {
                successes[i] = false;
            }
        }
    }

    /// @notice Read per-feed health for a batch. Isolates failures via try/catch.
    /// @param adapters Array of adapter addresses to query.
    /// @return results Per-adapter FeedHealth structs in the same order as input.
    function getFeedHealth(address[] calldata adapters) external view returns (FeedHealth[] memory results) {
        uint256 n = adapters.length;
        results = new FeedHealth[](n);

        for (uint256 i = 0; i < n; i++) {
            address a = adapters[i];
            FeedHealth memory h;
            h.adapter = a;

            // Short-circuit for EOAs / empty addresses: no code means no adapter.
            // Prevents "unexpected return data" reverts that escape try/catch
            // when the target has no code but returns are declared.
            if (a.code.length == 0) {
                h.isHealthy = false;
                results[i] = h;
                continue;
            }

            uint256 maxStale = 0;
            try IAdapterMetadata(a).metadata() returns (IAdapterMetadata.AdapterMetadata memory m) {
                h.isPaused = m.paused;
                maxStale = m.maxStaleness;
            } catch {
                // Adapter doesn't implement metadata() — mark unhealthy, skip rest.
                h.isHealthy = false;
                results[i] = h;
                continue;
            }

            try IAggregatorV3Interface(a).latestRoundData() returns (
                uint80,
                int256 answer,
                uint256,
                uint256 updatedAt,
                uint80
            ) {
                h.lastUpdate = updatedAt;
                h.latestPrice = answer;
                uint256 elapsed = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
                h.secondsSinceUpdate = elapsed;
                h.isStale = (maxStale > 0 && elapsed > maxStale);
                h.isHealthy = (!h.isPaused) && (!h.isStale) && (answer > 0);
            } catch {
                // Read reverted — feed unhealthy. Leave price/timestamp at zero.
                h.isHealthy = false;
            }

            results[i] = h;
        }
    }
}
