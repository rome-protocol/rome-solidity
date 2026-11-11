// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RomeNaming} from "../RomeNaming.sol";

/// @notice Exposes `RomeNaming` to tests. Texts go in and out as raw bytes, so bytes that are not valid UTF-8
///         can be sent.
contract RomeNamingHarness {
    function romeName(bytes calldata name) external pure returns (bytes memory) {
        return bytes(RomeNaming.romeName(string(name)));
    }

    function romeSymbol(bytes calldata symbol) external pure returns (bytes memory) {
        return bytes(RomeNaming.romeSymbol(string(symbol)));
    }

    /// @dev The cut a Metaplex metadata writer makes, to the limits the library names.
    function cut(bytes calldata text, uint256 maxBytes) external pure returns (bytes memory) {
        return RomeNaming.cut(text, maxBytes);
    }

    function metaplexLimits() external pure returns (uint256 nameMax, uint256 symbolMax) {
        return (RomeNaming.METAPLEX_NAME_MAX, RomeNaming.METAPLEX_SYMBOL_MAX);
    }

    /// @dev How many code points in [from, to) are in the table, and a hash chaining them in order.
    function table(uint256 from, uint256 to) external pure returns (uint256 count, bytes32 digest) {
        for (uint256 cp = from; cp < to; cp++) {
            if (RomeNaming.isControlOrFormat(cp)) {
                count++;
                digest = keccak256(abi.encodePacked(digest, uint32(cp)));
            }
        }
    }
}
