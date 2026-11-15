// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UserPda} from "../UserPda.sol";

/// @dev Test-only wrapper exposing UserPda.
contract UserPdaWrapper {
    function ataForKey(bytes32 ownerKey, bytes32 mint) external view returns (bytes32) {
        return UserPda.ataForKey(ownerKey, mint);
    }
}
