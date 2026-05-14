// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccountReader} from "../AccountReader.sol";

/// @dev Test-only wrapper exposing AccountReader. Every method here
///      delegates to the library so Hardhat/Foundry tests can call
///      against a deployed wrapper contract. Note: these reads require a
///      live Rome EVM stack (the CpiProgram precompile is not present on
///      hardhatMainnet), so all functional tests against this wrapper
///      run on `--network local` or per-chain devnet networks.
contract AccountReaderWrapper {
    function lamportsOf(bytes32 account) external view returns (uint64) {
        return AccountReader.lamportsOf(account);
    }

    function readU64At(bytes32 account, uint16 offset) external view returns (uint64) {
        return AccountReader.readU64At(account, offset);
    }

    function readBytesAt(bytes32 account, uint16 offset, uint16 length)
        external
        view
        returns (bytes memory)
    {
        return AccountReader.readBytesAt(account, offset, length);
    }

    function readBytes32At(bytes32 account, uint16 offset) external view returns (bytes32) {
        return AccountReader.readBytes32At(account, offset);
    }
}
