// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IAggregatorV3Interface.sol";

/// @title IExtendedOracleAdapter
/// @notice Extended oracle interface for protocols that want richer data.
///         Inherits IAggregatorV3Interface for full Chainlink compatibility.
interface IExtendedOracleAdapter is IAggregatorV3Interface {
    /// @notice Full price data including confidence
    /// @return price Raw price (before normalization)
    /// @return conf Confidence interval (same scale as price)
    /// @return expo Exponent (actual_price = price * 10^expo)
    /// @return publishTime Unix timestamp of price publication
    function latestPriceData()
        external
        view
        returns (int64 price, uint64 conf, int32 expo, uint64 publishTime);

    /// @notice EMA price data (Pyth only; Switchboard reverts)
    function latestEMAData()
        external
        view
        returns (int64 emaPrice, uint64 emaConf, int32 expo, uint64 publishTime);

    /// @notice Derived price status based on freshness
    /// @return 0 = Trading (fresh), 1 = Stale, 2 = Paused
    function priceStatus() external view returns (uint8);

    /// @notice Maximum acceptable age of price data in seconds
    function maxStaleness() external view returns (uint256);

    /// @notice The oracle source type
    /// @return 0 = PythPull, 1 = SwitchboardV3
    function oracleType() external view returns (uint8);
}
