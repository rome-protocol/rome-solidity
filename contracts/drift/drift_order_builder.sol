// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Convert} from "../convert.sol";

library DriftOrderBuilder {
    // OrderType
    uint8 internal constant ORDER_TYPE_MARKET = 0;
    uint8 internal constant ORDER_TYPE_LIMIT = 1;
    uint8 internal constant ORDER_TYPE_TRIGGER_MARKET = 2;
    uint8 internal constant ORDER_TYPE_TRIGGER_LIMIT = 3;
    uint8 internal constant ORDER_TYPE_ORACLE = 4;

    // MarketType
    uint8 internal constant MARKET_TYPE_PERP = 0;
    uint8 internal constant MARKET_TYPE_SPOT = 1;

    // PositionDirection
    uint8 internal constant DIRECTION_LONG = 0;
    uint8 internal constant DIRECTION_SHORT = 1;

    /// @notice Build a market order for a perp position
    /// @param market_index Perp market index
    /// @param direction DIRECTION_LONG or DIRECTION_SHORT
    /// @param base_asset_amount Amount in base asset units
    /// @return data Serialized place_perp_order instruction data
    function market_order(uint16 market_index, uint8 direction, uint64 base_asset_amount)
        internal
        pure
        returns (bytes memory data)
    {
        bytes8 disc = bytes8(sha256(bytes("global:place_perp_order")));
        data = abi.encodePacked(
            disc,
            // OrderParams struct fields:
            ORDER_TYPE_MARKET,                          // order_type: u8
            MARKET_TYPE_PERP,                           // market_type: u8
            direction,                                  // direction: u8
            uint8(0),                                   // user_order_id: u8
            Convert.u16le(market_index),                // market_index: u16
            Convert.u64le(base_asset_amount),           // base_asset_amount: u64
            Convert.u64le(0),                           // price: u64
            Convert.u64le(0),                           // quote_asset_amount: u64 (not used for market orders)
            uint8(0),                                   // reduce_only: bool
            uint8(0),                                   // post_only: enum (None=0)
            uint8(0),                                   // immediate_or_cancel: bool
            uint8(0),                                   // trigger_price: Option<u64> None
            uint8(0),                                   // trigger_condition: Option None
            uint8(0),                                   // oracle_price_offset: Option<i32> None
            uint8(0),                                   // auction_duration: Option<u8> None
            uint8(0),                                   // max_ts: Option<i64> None
            uint8(0)                                    // auction_start_price: Option<i64> None
        );
    }

    /// @notice Build a limit order for a perp position
    /// @param market_index Perp market index
    /// @param direction DIRECTION_LONG or DIRECTION_SHORT
    /// @param base_asset_amount Amount in base asset units
    /// @param price Limit price (PRICE_PRECISION = 1e6)
    /// @param post_only If true, order is post-only (maker)
    /// @param reduce_only If true, order can only reduce position
    /// @return data Serialized place_perp_order instruction data
    function limit_order(
        uint16 market_index,
        uint8 direction,
        uint64 base_asset_amount,
        uint64 price,
        bool post_only,
        bool reduce_only
    )
        internal
        pure
        returns (bytes memory data)
    {
        bytes8 disc = bytes8(sha256(bytes("global:place_perp_order")));
        data = abi.encodePacked(
            disc,
            // OrderParams struct fields:
            ORDER_TYPE_LIMIT,                           // order_type: u8
            MARKET_TYPE_PERP,                           // market_type: u8
            direction,                                  // direction: u8
            uint8(0),                                   // user_order_id: u8
            Convert.u16le(market_index),                // market_index: u16
            Convert.u64le(base_asset_amount),           // base_asset_amount: u64
            Convert.u64le(price),                       // price: u64
            Convert.u64le(0),                           // quote_asset_amount: u64
            reduce_only ? uint8(1) : uint8(0),          // reduce_only: bool
            post_only ? uint8(2) : uint8(0),            // post_only: enum (PostOnly=2, None=0)
            uint8(0),                                   // immediate_or_cancel: bool
            uint8(0),                                   // trigger_price: Option<u64> None
            uint8(0),                                   // trigger_condition: Option None
            uint8(0),                                   // oracle_price_offset: Option<i32> None
            uint8(0),                                   // auction_duration: Option<u8> None
            uint8(0),                                   // max_ts: Option<i64> None
            uint8(0)                                    // auction_start_price: Option<i64> None
        );
    }
}
