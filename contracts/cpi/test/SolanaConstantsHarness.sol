// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SolanaConstants} from "../SolanaConstants.sol";

/// @dev Test-only harness exposing the internal-constant library for the
///      ts-side cross-check tests.
contract SolanaConstantsHarness {
    function SYSTEM_PROGRAM() external pure returns (bytes32) {
        return SolanaConstants.SYSTEM_PROGRAM;
    }
    function SYSVAR_RENT() external pure returns (bytes32) {
        return SolanaConstants.SYSVAR_RENT;
    }
    function SYSVAR_INSTRUCTIONS() external pure returns (bytes32) {
        return SolanaConstants.SYSVAR_INSTRUCTIONS;
    }
    function SYSVAR_CLOCK() external pure returns (bytes32) {
        return SolanaConstants.SYSVAR_CLOCK;
    }
    function SPL_TOKEN_PROGRAM() external pure returns (bytes32) {
        return SolanaConstants.SPL_TOKEN_PROGRAM;
    }
    function ASSOCIATED_TOKEN_PROGRAM() external pure returns (bytes32) {
        return SolanaConstants.ASSOCIATED_TOKEN_PROGRAM;
    }
    function TOKEN_2022_PROGRAM() external pure returns (bytes32) {
        return SolanaConstants.TOKEN_2022_PROGRAM;
    }
}
