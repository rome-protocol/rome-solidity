// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UserPda} from "../UserPda.sol";

/// @dev Test-only wrapper exposing UserPda. The `pda` / `ata` paths require
///      a live Rome EVM precompile (SystemProgram.find_program_address +
///      RomeEVMAccount.pda), so full on-chain tests run on the `local`
///      network. Pure paths (ataForKey) are testable on hardhatMainnet.
contract UserPdaWrapper {
    function pda(address user) external view returns (bytes32) {
        return UserPda.pda(user);
    }

    function ata(address user, bytes32 mint) external view returns (bytes32) {
        return UserPda.ata(user, mint);
    }

    function ataForKey(bytes32 ownerKey, bytes32 mint) external pure returns (bytes32) {
        return UserPda.ataForKey(ownerKey, mint);
    }

    function ataWithProgram(address user, bytes32 mint, bytes32 tokenProgram)
        external
        view
        returns (bytes32)
    {
        return UserPda.ataWithProgram(user, mint, tokenProgram);
    }

    /// Live-precompile path: N ATAs for one user via PdasBatch under the hood.
    function atas(address user, bytes32[] memory mints)
        external
        view
        returns (bytes32[] memory)
    {
        return UserPda.atas(user, mints);
    }

    /// Empty-input shape check — exercises the early-return path that
    /// short-circuits before touching the precompile, so this can run on
    /// hardhatMainnet without a live Rome stack.
    function atasEmptyLength(address user) external view returns (uint256) {
        bytes32[] memory mints = new bytes32[](0);
        return UserPda.atas(user, mints).length;
    }
}
