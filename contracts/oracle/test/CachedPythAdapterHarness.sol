// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../CachedPythAdapter.sol";

/// @title CachedPythAdapterHarness
/// @notice Test harness for CachedPythAdapter: resets `initialized` so the
///         harness can initialize itself (no clone needed), and overrides
///         `_fetchAccount` to return injectable mock PriceUpdateV2 bytes —
///         the CPI precompile (`account_data_at`) is unavailable on hardhat's
///         simulated network.
contract CachedPythAdapterHarness is CachedPythAdapter {
    bytes private mockData;

    constructor() CachedPythAdapter() {
        initialized = false;
    }

    function setMockData(bytes calldata data) external {
        mockData = data;
    }

    function _fetchAccount() internal view override returns (bytes memory) {
        return mockData;
    }
}
