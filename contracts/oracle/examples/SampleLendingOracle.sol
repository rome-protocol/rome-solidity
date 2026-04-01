// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../IAggregatorV3Interface.sol";

/// @title SampleLendingOracle
/// @notice Example consumer demonstrating standard Chainlink-style usage
///         of PythAggregatorV3 adapters for a lending protocol.
contract SampleLendingOracle {
    uint256 public constant MAX_STALENESS = 60; // 60 seconds

    mapping(address => IAggregatorV3Interface) public priceFeeds;

    function setPriceFeed(address token, address aggregator) external {
        priceFeeds[token] = IAggregatorV3Interface(aggregator);
    }

    function getPrice(address token) public view returns (int256) {
        IAggregatorV3Interface feed = priceFeeds[token];
        require(address(feed) != address(0), "Feed not set");

        (
            uint80 roundId,
            int256 answer,
            ,
            uint256 updatedAt,
            uint80 answeredInRound
        ) = feed.latestRoundData();

        // Standard Chainlink consumer checks
        require(roundId > 0, "Invalid round");
        require(answer > 0, "Invalid price");
        require(updatedAt > 0, "Stale price");
        require(answeredInRound >= roundId, "Stale round");
        require(block.timestamp - updatedAt <= MAX_STALENESS, "Price too old");

        return answer;
    }

    /// @notice Check if a position is liquidatable
    function isLiquidatable(
        address collateralToken,
        address debtToken,
        uint256 collateralAmount,
        uint256 debtAmount,
        uint256 liquidationThreshold // e.g., 8000 = 80%
    ) external view returns (bool) {
        int256 collateralPrice = getPrice(collateralToken);
        int256 debtPrice = getPrice(debtToken);

        // Both prices are 8 decimals
        uint256 collateralValue = collateralAmount * uint256(collateralPrice);
        uint256 debtValue = debtAmount * uint256(debtPrice);

        return collateralValue * liquidationThreshold / 10000 < debtValue;
    }
}
