// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../convert.sol";

/// @title SwitchboardParser
/// @notice Parses AggregatorAccountData from Switchboard V2 on Solana.
/// @dev Switchboard stores results as SwitchboardDecimal:
///   - mantissa: i128 (16 bytes, little-endian)
///   - scale: u32 (4 bytes, little-endian)
///   - actual_value = mantissa / 10^scale
///
/// Validated layout (from live SOL/USD aggregator GvDMxP... on monti_spl):
///   Offset  Size  Field
///   0       8     Anchor discriminator (0xd9e64165c9a21b7d)
///   8       32    name
///   ...           (many config fields)
///   350     8     latest_confirmed_round.round_open_slot (u64)
///   358     8     latest_confirmed_round.round_open_timestamp (i64)
///   366     16    latest_confirmed_round.result.mantissa (i128)
///   382     4     latest_confirmed_round.result.scale (u32)
///
/// IMPORTANT: These offsets are empirically validated against the live account.
/// Run validate-switchboard-offsets.ts to re-confirm before redeployment.
library SwitchboardParser {
    error InvalidSwitchboardAccount();
    error SwitchboardDataTooShort();

    /// @notice Anchor discriminator for AggregatorAccountData
    /// sha256("account:AggregatorAccountData")[0..8]
    // Switchboard V3 AggregatorAccountData Anchor discriminator.
    // Derivation: bytes8(sha256("account:AggregatorAccountData")) = 0xd9e64165c9a21b7d.
    // If Switchboard renames the account type, update this constant AND the
    // byte layout. Run scripts/oracle/validate-switchboard-offsets.ts against
    // a live Solana devnet aggregator to confirm post-change.
    bytes8 constant DISCRIMINATOR = 0xd9e64165c9a21b7d;

    /// @notice Byte offset of latest_confirmed_round.round_open_slot
    uint256 constant ROUND_SLOT_OFFSET = 350;
    /// @notice Byte offset of latest_confirmed_round.round_open_timestamp
    uint256 constant ROUND_TIMESTAMP_OFFSET = 358;
    /// @notice Byte offset of latest_confirmed_round.result.mantissa
    uint256 constant RESULT_MANTISSA_OFFSET = 366;
    /// @notice Byte offset of latest_confirmed_round.result.scale
    uint256 constant RESULT_SCALE_OFFSET = 382;

    /// @notice Minimum account data length (must cover through scale field)
    uint256 constant MIN_DATA_LENGTH = 386;

    struct SwitchboardPrice {
        int128 mantissa;
        uint32 scale;
        int64 timestamp;
        uint64 slot;
    }

    /// @notice Parse a Switchboard V2 AggregatorAccountData
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

        // round_open_slot (u64, LE)
        (parsed.slot,) = Convert.read_u64le(data, ROUND_SLOT_OFFSET);

        // round_open_timestamp (i64, LE)
        (parsed.timestamp,) = Convert.read_i64le(data, ROUND_TIMESTAMP_OFFSET);

        // result.mantissa (i128, LE)
        (parsed.mantissa,) = Convert.read_i128le(data, RESULT_MANTISSA_OFFSET);

        // result.scale (u32, LE)
        (parsed.scale,) = Convert.read_u32le(data, RESULT_SCALE_OFFSET);
    }
}
