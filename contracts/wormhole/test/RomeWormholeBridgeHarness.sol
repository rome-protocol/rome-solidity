// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../RomeWormholeBridge.sol";

/// @title RomeWormholeBridgeHarness
/// @notice Thin wrapper for unit-testing RomeWormholeBridge on Hardhat's simulated EVM.
///         On Hardhat the CPI precompile (0xFF..08) has no code, so delegatecall returns
///         success with empty data — functions that reach CPI will silently succeed.
///         This is fine for testing validation guards and pause behaviour which fire
///         before the CPI call.
///
///         Currently unused — the tests deploy RomeWormholeBridge directly. This harness
///         exists as a hook for any future test-only overrides.
contract RomeWormholeBridgeHarness is RomeWormholeBridge {
    // Placeholder — extend if test-only helpers are needed in the future.
}
