// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../IAggregatorV3Interface.sol";

/// @title MockAggregatorV3
/// @notice Minimal settable AggregatorV3 feed for unit-testing CachedFeedAdapter
///         without a live Pyth/Switchboard source (no CPI precompile needed).
contract MockAggregatorV3 is IAggregatorV3Interface {
    int256 private _answer;
    uint256 private _updatedAt;
    uint8 private _dec;

    constructor(int256 answer_, uint256 updatedAt_, uint8 dec_) {
        _answer = answer_;
        _updatedAt = updatedAt_;
        _dec = dec_;
    }

    function setRound(int256 answer_, uint256 updatedAt_) external {
        _answer = answer_;
        _updatedAt = updatedAt_;
    }

    function decimals() external view override returns (uint8) {
        return _dec;
    }

    function description() external pure override returns (string memory) {
        return "MOCK / USD";
    }

    function version() external pure override returns (uint256) {
        return 1;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (1, _answer, _updatedAt, _updatedAt, 1);
    }

    function getRoundData(uint80) external pure override returns (uint80, int256, uint256, uint256, uint80) {
        revert("no historical rounds");
    }
}
