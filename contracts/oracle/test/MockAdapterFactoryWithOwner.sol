// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockAdapterFactoryWithOwner
/// @notice Test-only minimal factory that satisfies what PythLazerCache needs:
///         `owner()` for `setMaxStaleness` gating, plus `isPaused(adapter)` for
///         symmetry with the real OracleAdapterFactory (cache itself doesn't
///         read isPaused, but a future adapter test reuses this mock).
contract MockAdapterFactoryWithOwner {
    address public owner;
    mapping(address => bool) public pausedAdapters;

    constructor(address _owner) {
        owner = _owner;
    }

    function isPaused(address adapter) external view returns (bool) {
        return pausedAdapters[adapter];
    }

    function setPaused(address adapter, bool paused) external {
        pausedAdapters[adapter] = paused;
    }

    function setOwner(address newOwner) external {
        owner = newOwner;
    }
}
