// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAggregatorV3Interface} from "../../oracle/IAggregatorV3Interface.sol";

/// @dev Mock Chainlink-compat price adapter for CostEstimator tests.
///      Returns a caller-set `priceE8` with a fixed roundId/timestamp.
contract MockPriceAdapter is IAggregatorV3Interface {
    int256 public priceE8;

    constructor(int256 _priceE8) {
        priceE8 = _priceE8;
    }

    function setPrice(int256 _priceE8) external {
        priceE8 = _priceE8;
    }

    function decimals() external pure override returns (uint8) {
        return 8;
    }
    function description() external pure override returns (string memory) {
        return "MOCK";
    }
    function version() external pure override returns (uint256) {
        return 1;
    }

    function getRoundData(uint80 /*roundId*/)
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, priceE8, block.timestamp, block.timestamp, 1);
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (1, priceE8, block.timestamp, block.timestamp, 1);
    }
}
