// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../SwitchboardParser.sol";

/// @title SwitchboardParserHarness
/// @notice Test wrapper that exposes SwitchboardParser's internal library functions
///         as external calls for unit testing.
contract SwitchboardParserHarness {
    function parse(bytes memory data) external pure returns (
        int128 mantissa,
        uint32 scale,
        int64 timestamp,
        uint64 slot
    ) {
        SwitchboardParser.SwitchboardPrice memory parsed = SwitchboardParser.parse(data);
        return (parsed.mantissa, parsed.scale, parsed.timestamp, parsed.slot);
    }
}
