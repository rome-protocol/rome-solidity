// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../PythLazerCache.sol";

/// @title PythLazerCacheHarness
/// @notice Test-only subclass that exposes PythLazerCache's internal helpers
///         so unit tests can exercise them without going through the
///         `IHelperProgram(HELPER).lazer_price(...)` precompile path.
///
///         Production refresh() is exercised end-to-end via Hadrian
///         integration tests; unit tests cover the storage / normalization
///         logic in isolation via this harness.
contract PythLazerCacheHarness is PythLazerCache {
    constructor(address _factory, uint64 _maxStaleness)
        PythLazerCache(_factory, _maxStaleness)
    {}

    /// @notice Test-only — expose the internal 8-decimal normalizer.
    function normalize(int64 price, int16 expo) external pure returns (int256) {
        return _normalize(price, expo);
    }
}
