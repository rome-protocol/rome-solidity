// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";

/// @title AdapterCloneFactory
/// @notice Minimal test helper for deploying EIP-1167 clones of adapter
///         implementations without going through OracleAdapterFactory (which
///         calls the CPI precompile to validate Solana account ownership).
///         Used by unit tests that need to instantiate a clone and call
///         initialize() directly.
contract AdapterCloneFactory {
    event Cloned(address indexed implementation, address indexed clone);

    function cloneOf(address implementation) external returns (address clone) {
        clone = Clones.clone(implementation);
        emit Cloned(implementation, clone);
    }
}
