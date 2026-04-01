// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IAggregatorV3Interface.sol";
import "./PythParser.sol";
import "../interface.sol";

/// @title PythAggregatorV3
/// @notice Per-feed adapter that reads a Pyth PriceAccount via Rome's CPI
///         precompile and exposes it through the Chainlink AggregatorV3Interface.
/// @dev Deployed by PythAggregatorFactory. One instance per Pyth price feed.
contract PythAggregatorV3 is IAggregatorV3Interface {
    bytes32 public immutable pythAccount;
    string private _description;

    constructor(bytes32 _pythAccount, string memory desc) {
        pythAccount = _pythAccount;
        _description = desc;
    }

    /// @notice Always 8 — prices are normalized to 10^-8
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    /// @notice Returns the latest Pyth price normalized to 8 decimals
    /// @dev Reads raw Pyth account data via CPI precompile, parses with
    ///      PythParser, normalizes exponent, and maps to Chainlink fields.
    ///      Reverts if the price is <= 0.
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        // Read raw Pyth account data via CPI precompile
        (,,,,, bytes memory data) = CpiProgram.account_info(pythAccount);

        // Parse with version-aware parser
        (int64 price, , int32 expo, uint64 publishTime) = PythParser.parse(data);

        // Revert on non-positive price
        require(price > 0, "Negative price");

        // Normalize to 8 decimals
        answer = _normalize(price, expo);

        // Map Pyth fields to Chainlink interface
        // Pyth has no round concept; fixed value satisfies roundId != 0 checks
        roundId = 1;
        startedAt = uint256(publishTime);
        updatedAt = uint256(publishTime);
        answeredInRound = 1;
    }

    /// @notice Historical rounds are not supported by Pyth
    function getRoundData(uint80) external pure returns (
        uint80, int256, uint256, uint256, uint80
    ) {
        revert("Historical rounds not supported");
    }

    /// @notice Convenience: returns just the latest price
    function latestAnswer() external view returns (int256) {
        (, int256 answer,,,) = this.latestRoundData();
        return answer;
    }

    /// @notice Convenience: returns just the latest timestamp
    function latestTimestamp() external view returns (uint256) {
        (,,, uint256 updatedAt,) = this.latestRoundData();
        return updatedAt;
    }

    /// @notice Convenience: returns the latest round (always 1)
    function latestRound() external pure returns (uint256) {
        return 1;
    }

    /// @dev Normalize Pyth price (int64 * 10^expo) to 8 decimals (10^-8).
    ///      answer = price * 10^(expo - targetExpo)
    ///      Uses Solidity 0.8.x checked arithmetic for overflow safety.
    function _normalize(int64 price, int32 expo) internal pure returns (int256) {
        int256 scaledPrice = int256(price);
        int32 targetExpo = -8;
        int32 diff = expo - targetExpo; // e.g., expo=-5 → diff=3 → multiply

        if (diff > 0) {
            // Fewer decimals than target: multiply to add precision
            scaledPrice = scaledPrice * int256(10 ** uint32(diff));
        } else if (diff < 0) {
            // More decimals than target: divide (lossy truncation)
            scaledPrice = scaledPrice / int256(10 ** uint32(-diff));
        }
        // diff == 0: already at 8 decimals

        return scaledPrice;
    }
}
