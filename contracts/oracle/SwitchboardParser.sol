// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../convert.sol";

/// @title SwitchboardParser
/// @notice Parses AggregatorAccountData from Switchboard V3.
/// @dev Switchboard stores results as SwitchboardDecimal:
///   - mantissa: i128 (16 bytes, little-endian)
///   - scale: u32 (4 bytes, little-endian)
///   - actual_value = mantissa / 10^scale
///
/// The latest_confirmed_round contains result, round_open_slot, round_open_timestamp.
///
/// IMPORTANT: The exact byte offset of latest_confirmed_round.result must be
/// confirmed by reading a live Switchboard aggregator on devnet.
/// Run validate-switchboard-offsets.ts before deployment.
library SwitchboardParser {
    error InvalidSwitchboardAccount();
    error SwitchboardDataTooShort();

    /// @notice Anchor discriminator for AggregatorAccountData
    /// Must be validated against live account before deployment
    bytes8 constant DISCRIMINATOR = 0xd790d78a3102f2af;

    /// @notice Byte offset of latest_confirmed_round.result in AggregatorAccountData
    /// This is a large struct — offset must be validated empirically
    uint256 constant LATEST_RESULT_OFFSET = 176;

    /// @notice Minimum account data length
    uint256 constant MIN_DATA_LENGTH = 224;

    struct SwitchboardPrice {
        int128 mantissa;
        uint32 scale;
        int64 timestamp;
        uint64 slot;
    }

    /// @notice Parse a Switchboard V3 AggregatorAccountData
    /// @param data Raw account data from CPI precompile
    /// @return parsed The parsed price data
    function parse(bytes memory data) internal pure returns (SwitchboardPrice memory parsed) {
        if (data.length < MIN_DATA_LENGTH) revert SwitchboardDataTooShort();

        // Validate Anchor discriminator (first 8 bytes)
        bytes8 disc;
        assembly {
            disc := mload(add(data, 0x20))
        }
        if (disc != DISCRIMINATOR) revert InvalidSwitchboardAccount();

        // latest_confirmed_round.result.mantissa at LATEST_RESULT_OFFSET (i128, LE)
        (parsed.mantissa,) = Convert.read_i128le(data, LATEST_RESULT_OFFSET);

        // latest_confirmed_round.result.scale at LATEST_RESULT_OFFSET + 16 (u32, LE)
        (parsed.scale,) = Convert.read_u32le(data, LATEST_RESULT_OFFSET + 16);

        // round_open_slot at LATEST_RESULT_OFFSET + 20 (u64, LE)
        (parsed.slot,) = Convert.read_u64le(data, LATEST_RESULT_OFFSET + 20);

        // round_open_timestamp at LATEST_RESULT_OFFSET + 28 (i64, LE)
        (parsed.timestamp,) = Convert.read_i64le(data, LATEST_RESULT_OFFSET + 28);
    }
}
