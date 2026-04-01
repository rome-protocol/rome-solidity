// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../convert.sol";

/// @title PythParser
/// @notice Version-aware Borsh parser for Pyth PriceAccount data
/// @dev Reuses Convert library for little-endian unsigned reads;
///      adds signed readers for Pyth-specific fields.
library PythParser {
    uint32 constant PYTH_MAGIC = 0xa1b2c3d4;

    error UnsupportedPythVersion(uint32 version);
    error InvalidPythAccount();

    /// @notice Parse Pyth PriceAccount data, version-aware
    /// @param data Raw account data from account_info
    /// @return price The aggregate price (int64)
    /// @return conf The confidence interval (uint64)
    /// @return expo The exponent (int32)
    /// @return publishTime The publish timestamp (uint64)
    function parse(bytes memory data) internal pure returns (
        int64 price,
        uint64 conf,
        int32 expo,
        uint64 publishTime
    ) {
        require(data.length >= 48, "Data too short");

        // Read magic number (bytes 0-3, little-endian)
        (uint32 magic,) = Convert.read_u32le(data, 0);
        if (magic != PYTH_MAGIC) revert InvalidPythAccount();

        // Read version (bytes 4-7, little-endian)
        (uint32 ver,) = Convert.read_u32le(data, 4);

        if (ver == 2) {
            return parseV2(data);
        } else {
            revert UnsupportedPythVersion(ver);
        }
    }

    /// @notice Parse Pyth V2 PriceAccount layout
    /// @dev Layout (little-endian):
    ///   [0..4]     magic (0xa1b2c3d4)
    ///   [4..8]     version (2)
    ///   [8..12]    account_type
    ///   [12..16]   size
    ///   [16..20]   price_type
    ///   [20..24]   exponent (int32)
    ///   [24..28]   num_component_prices
    ///   [28..32]   num_quoters
    ///   [32..40]   last_slot
    ///   [40..48]   valid_slot
    ///   ...
    ///   [208..216] aggregate price (int64)
    ///   [216..224] aggregate conf (uint64)
    ///   [224..228] aggregate status (uint32)
    ///   ...
    ///   [232..240] publish_time (int64, treated as uint64)
    ///
    /// NOTE: Offsets are based on the Pyth V2 specification and MUST be
    /// validated against a live Pyth account during deployment.
    function parseV2(bytes memory data) private pure returns (
        int64 price,
        uint64 conf,
        int32 expo,
        uint64 publishTime
    ) {
        require(data.length >= 240, "V2 data too short");

        // Exponent at offset 20 (int32, little-endian)
        expo = _readInt32LE(data, 20);

        // Aggregate price at offset 208 (int64, little-endian)
        price = _readInt64LE(data, 208);

        // Aggregate confidence at offset 216 (uint64, little-endian)
        (conf,) = Convert.read_u64le(data, 216);

        // Publish time at offset 232 (int64 as uint64, little-endian)
        publishTime = uint64(_readInt64LE(data, 232));
    }

    // --- Signed little-endian readers ---
    // Reuse Convert's unsigned LE reads and reinterpret as signed.

    function _readInt32LE(bytes memory data, uint256 offset) private pure returns (int32) {
        (uint32 val,) = Convert.read_u32le(data, offset);
        return int32(val);
    }

    function _readInt64LE(bytes memory data, uint256 offset) private pure returns (int64) {
        (uint64 val,) = Convert.read_u64le(data, offset);
        return int64(val);
    }
}
