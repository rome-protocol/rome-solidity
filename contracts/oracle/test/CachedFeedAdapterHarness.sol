// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../CachedFeedAdapter.sol";

/// @title CachedFeedAdapterHarness
/// @notice Resets `initialized` after the parent constructor so the harness can
///         be initialized directly in tests (no clone needed). CachedFeedAdapter
///         reads its underlying via a normal external call, so — unlike the Pyth
///         harness — no _fetchAccount override is needed; a mock AggregatorV3
///         underlying works on hardhat's simulated network.
contract CachedFeedAdapterHarness is CachedFeedAdapter {
    constructor() CachedFeedAdapter() {
        initialized = false;
    }
}
