// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IAdapterFactory
/// @notice Minimal interface for adapters to query pause state from the factory.
interface IAdapterFactory {
    function isPaused(address adapter) external view returns (bool);
}
