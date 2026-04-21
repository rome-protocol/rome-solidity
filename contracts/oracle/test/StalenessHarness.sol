// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../PythPullAdapter.sol";
import "../SwitchboardV3Adapter.sol";

/// @title PythStalenessHarness
/// @notice Exposes `PythPullAdapter._checkStaleness` externally so the
///         H-1 underflow guard can be unit-tested without the CPI precompile.
///         Overrides the adapter's constructor so `initialized` stays false
///         and `initialize()` can set `maxStaleness` during test setup.
contract PythStalenessHarness is PythPullAdapter {
    /// @dev Reset `initialized` after the parent constructor ran so this test
    ///      contract can itself call initialize() as if it were a clone.
    constructor() PythPullAdapter() {
        initialized = false;
    }

    function checkStalenessExt(uint64 publishTime) external view {
        _checkStaleness(publishTime);
    }
}

/// @title SwitchboardStalenessHarness
/// @notice Same as PythStalenessHarness but for SwitchboardV3Adapter.
contract SwitchboardStalenessHarness is SwitchboardV3Adapter {
    constructor() SwitchboardV3Adapter() {
        initialized = false;
    }

    function checkStalenessExt(int64 timestamp) external view {
        _checkStaleness(timestamp);
    }
}
