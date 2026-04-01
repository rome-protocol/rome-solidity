// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../convert.sol";

/// @title PythPullParser
/// @notice Parses PriceUpdateV2 accounts from Pyth Solana Receiver (pull model).
/// @dev Layout (Borsh/Anchor serialized, little-endian):
///   Offset  Size  Type     Field
///   0       8     bytes    Anchor discriminator
///   8       32    Pubkey   write_authority
///   40      2     enum     verification_level (1 byte tag + 1 byte num_signatures)
///   42      32    [u8;32]  feed_id
///   74      8     i64      price
///   82      8     u64      conf
///   90      4     i32      exponent
///   94      8     i64      publish_time
///   102     8     i64      prev_publish_time
///   110     8     i64      ema_price
///   118     8     u64      ema_conf
///   126     8     u64      posted_slot
///   Total: 134 bytes minimum
///
/// IMPORTANT: These offsets are derived from Pyth's PriceUpdateV2 Anchor struct.
/// Run validate-pyth-pull-offsets.ts against a live account before deployment.
library PythPullParser {
    error InvalidPythPullAccount();
    error PythPullDataTooShort();

    uint256 constant MIN_DATA_LENGTH = 134;

    /// @notice Anchor discriminator for PriceUpdateV2
    /// sha256("account:PriceUpdateV2")[0..8] — must be validated against live account
    bytes8 constant DISCRIMINATOR = 0x22f123639d7ef4cd;

    struct PythPullPrice {
        int64 price;
        uint64 conf;
        int32 expo;
        uint64 publishTime;
        int64 emaPrice;
        uint64 emaConf;
    }

    /// @notice Parse a PriceUpdateV2 account's raw bytes
    /// @param data Raw account data from CPI precompile
    /// @return parsed The parsed price data
    function parse(bytes memory data) internal pure returns (PythPullPrice memory parsed) {
        if (data.length < MIN_DATA_LENGTH) revert PythPullDataTooShort();

        // Validate Anchor discriminator (first 8 bytes)
        bytes8 disc;
        assembly {
            disc := mload(add(data, 0x20))
        }
        if (disc != DISCRIMINATOR) revert InvalidPythPullAccount();

        // price at offset 74 (int64, LE)
        (parsed.price,) = Convert.read_i64le(data, 74);

        // conf at offset 82 (uint64, LE)
        (parsed.conf,) = Convert.read_u64le(data, 82);

        // exponent at offset 90 (int32, LE)
        {
            (uint32 rawExpo,) = Convert.read_u32le(data, 90);
            parsed.expo = int32(rawExpo);
        }

        // publish_time at offset 94 (i64, LE)
        {
            (int64 pt,) = Convert.read_i64le(data, 94);
            parsed.publishTime = uint64(pt);
        }

        // ema_price at offset 110 (int64, LE)
        (parsed.emaPrice,) = Convert.read_i64le(data, 110);

        // ema_conf at offset 118 (uint64, LE)
        (parsed.emaConf,) = Convert.read_u64le(data, 118);
    }
}
