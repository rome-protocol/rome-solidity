// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SplTokenLib} from "../spl_token.sol";

/// @notice Test-only surface for the pure parsers in SplTokenLib.
/// @dev Mirrors the wrapper convention in contracts/cpi/test — internal library
///      functions need an external entry point to be called from a test, and the
///      library itself stays free of one.
contract SplTokenLibHarness {
    function metadataPointer(bytes calldata data) external pure returns (bool, bytes32) {
        return SplTokenLib.metadata_pointer(data);
    }

    function tokenMetadata(bytes calldata data)
        external
        pure
        returns (bool, string memory, string memory)
    {
        return SplTokenLib.token_metadata(data);
    }
}
