// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../PythPullParser.sol";

/// @title PythPullParserHarness
/// @notice Test wrapper that exposes PythPullParser's internal library functions
///         as external calls for unit testing.
contract PythPullParserHarness {
    function parse(bytes memory data) external pure returns (
        int64 price,
        uint64 conf,
        int32 expo,
        uint64 publishTime,
        int64 emaPrice,
        uint64 emaConf
    ) {
        PythPullParser.PythPullPrice memory parsed = PythPullParser.parse(data);
        return (parsed.price, parsed.conf, parsed.expo, parsed.publishTime, parsed.emaPrice, parsed.emaConf);
    }
}
