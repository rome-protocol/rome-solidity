// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../convert.sol";

/// @title PythPullParser
/// @notice Parses PriceUpdateV2 accounts from Pyth Solana Receiver (pull model).
/// @dev Layout (Borsh/Anchor serialized, little-endian):
///   Offset  Size  Type     Field
///   0       8     bytes    Anchor discriminator
///   8       32    Pubkey   write_authority
///   40      1     enum     verification_level (Full=0x01, 1 byte; Partial=0x00 + 1 byte)
///   41      32    [u8;32]  feed_id
///   73      8     i64      price
///   81      8     u64      conf
///   89      4     i32      exponent
///   93      8     i64      publish_time
///   101     8     i64      prev_publish_time
///   109     8     i64      ema_price
///   117     8     u64      ema_conf
///   125     8     u64      posted_slot
///   Total: 133 bytes (Full variant)
///
/// NOTE: Borsh enum serialization is variable-length. The Full variant has no
/// inner data (1 byte tag only), while Partial has num_signatures (1 byte tag
/// + 1 byte u8 = 2 bytes). This parser reads at offsets for the Full variant.
/// On-chain PriceFeedAccount PDAs maintained by the push oracle always use Full.
///
/// IMPORTANT: These offsets are validated against live accounts on monti_spl.
/// Run validate-pyth-pull-offsets.ts to re-confirm before any redeployment.
library PythPullParser {
    error InvalidPythPullAccount();
    error PythPullDataTooShort();

    uint256 constant MIN_DATA_LENGTH = 133;

    /// @notice Anchor discriminator for PriceUpdateV2
    /// sha256("account:PriceUpdateV2")[0..8]
    // Pyth PriceUpdateV2 Anchor discriminator.
    // Derivation: bytes8(sha256("account:PriceUpdateV2")) = 0x22f123639d7ef4cd.
    // If Pyth migrates to PriceUpdateV3 or similar, update this constant AND
    // the byte layout below. Run scripts/oracle/validate-pyth-pull-offsets.ts
    // against a live Solana devnet feed to confirm post-change.
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

        // price at offset 73 (int64, LE)
        (parsed.price,) = Convert.read_i64le(data, 73);

        // conf at offset 81 (uint64, LE)
        (parsed.conf,) = Convert.read_u64le(data, 81);

        // exponent at offset 89 (int32, LE)
        {
            (uint32 rawExpo,) = Convert.read_u32le(data, 89);
            parsed.expo = int32(rawExpo);
        }

        // publish_time at offset 93 (i64, LE)
        {
            (int64 pt,) = Convert.read_i64le(data, 93);
            parsed.publishTime = uint64(pt);
        }

        // ema_price at offset 109 (int64, LE)
        (parsed.emaPrice,) = Convert.read_i64le(data, 109);

        // ema_conf at offset 117 (uint64, LE)
        (parsed.emaConf,) = Convert.read_u64le(data, 117);
    }
}
