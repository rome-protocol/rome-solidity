// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../PythParser.sol";

/// @title PythParserHarness
/// @notice Test wrapper that exposes PythParser's internal library functions
///         as external calls for unit testing.
contract PythParserHarness {
    function parse(bytes memory data) external pure returns (
        int64 price,
        uint64 conf,
        int32 expo,
        uint64 publishTime
    ) {
        return PythParser.parse(data);
    }
}
