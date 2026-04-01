// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title NormalizerHarness
/// @notice Exposes PythAggregatorV3's internal _normalize logic for unit testing.
contract NormalizerHarness {
    /// @dev Same logic as PythAggregatorV3._normalize
    function normalize(int64 price, int32 expo) external pure returns (int256) {
        int256 scaledPrice = int256(price);
        int32 targetExpo = -8;
        int32 diff = expo - targetExpo;

        if (diff > 0) {
            scaledPrice = scaledPrice * int256(10 ** uint32(diff));
        } else if (diff < 0) {
            scaledPrice = scaledPrice / int256(10 ** uint32(-diff));
        }

        return scaledPrice;
    }
}
