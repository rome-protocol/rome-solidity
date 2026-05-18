// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EnsureAta} from "../EnsureAta.sol";

/// @title EnsureAtaHarness
/// @notice Test-only wrapper exposing the internal EnsureAta library as
///         an external entry point so integration tests can verify the
///         on-chain behaviour against Hadrian.
contract EnsureAtaHarness {
    function ensure(address user, bytes32 mint) external {
        EnsureAta.ensure(user, mint);
    }
}
