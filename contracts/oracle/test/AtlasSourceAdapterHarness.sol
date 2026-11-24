// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../IAggregatorV3Interface.sol";
import "../IAdapterMetadata.sol";

/// @title AtlasSourceAdapterHarness
/// @notice Test adapter whose `metadata().sourceType` is `OracleSource.Atlas`
///         (a plain-EVM source with no Solana account). Lets BatchReader be
///         tested against the third source value without an Atlas book.
contract AtlasSourceAdapterHarness is IAggregatorV3Interface, IAdapterMetadata {
    int256 public answer;
    uint256 public updatedAt;
    uint256 public maxStaleness;
    bool public paused;
    bool public reverting;

    constructor(int256 answer_, uint256 updatedAt_, uint256 maxStaleness_) {
        answer = answer_;
        updatedAt = updatedAt_;
        maxStaleness = maxStaleness_;
    }

    function set(int256 answer_, uint256 updatedAt_, bool paused_, bool reverting_) external {
        answer = answer_;
        updatedAt = updatedAt_;
        paused = paused_;
        reverting = reverting_;
    }

    function decimals() external pure override returns (uint8) {
        return 8;
    }

    function description() external pure override returns (string memory) {
        return "ATLAS / USD";
    }

    function version() external pure override returns (uint256) {
        return 2;
    }

    function metadata() external view override returns (AdapterMetadata memory) {
        return AdapterMetadata({
            description: "ATLAS / USD",
            sourceType: OracleSource.Atlas,
            solanaAccount: bytes32(bytes4(0x00000cfb)),
            maxStaleness: maxStaleness,
            createdAt: 0,
            factory: address(this),
            paused: paused
        });
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverting && !paused, "feed unavailable");
        return (1, answer, updatedAt, updatedAt, 1);
    }

    function getRoundData(uint80) external pure override returns (uint80, int256, uint256, uint256, uint80) {
        revert("no historical rounds");
    }
}
