// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {Convert} from "../convert.sol";
import {DriftPDA} from "./drift_pda.sol";

library DriftLib {
    uint256 internal constant PERP_MARKET_MIN_LEN = 1216;
    uint256 internal constant SPOT_MARKET_MIN_LEN = 776;
    uint256 internal constant USER_MIN_LEN = 4376;
    uint256 internal constant STATE_MIN_LEN = 200;

    uint8 internal constant MAX_PERP_POSITIONS = 8;
    uint8 internal constant MAX_SPOT_POSITIONS = 8;

    uint256 internal constant SPOT_POSITION_SIZE = 40;
    uint256 internal constant PERP_POSITION_SIZE = 112;

    uint256 internal constant USER_AUTHORITY_OFFSET = 8;
    uint256 internal constant USER_SPOT_POSITIONS_OFFSET = 104;
    uint256 internal constant USER_PERP_POSITIONS_OFFSET = 424;

    error InvalidDataLength(string account_type, uint256 actual, uint256 expected);
    error InvalidOwner(bytes32 actual, bytes32 expected);

    struct PerpMarketSummary {
        uint16 market_index;
        uint8 status;
        bytes32 oracle;
        uint128 base_asset_reserve;
        uint128 quote_asset_reserve;
        int128 cumulative_funding_long;
        int128 cumulative_funding_short;
        int64 last_funding_rate_ts;
        uint128 open_interest;
    }

    struct SpotMarketSummary {
        bytes32 oracle;
        bytes32 mint;
        bytes32 vault;
        uint128 deposit_balance;
        uint128 borrow_balance;
        uint128 cumulative_deposit_interest;
        uint128 cumulative_borrow_interest;
        uint16 market_index;
        uint8 status;
        uint8 decimals;
    }

    struct SpotPosition {
        uint64 scaled_balance;
        int64 open_bids;
        int64 open_asks;
        int64 cumulative_deposits;
        uint16 market_index;
        uint8 balance_type;
    }

    struct PerpPosition {
        int64 last_cumulative_funding_rate;
        int64 base_asset_amount;
        int64 quote_asset_amount;
        int64 quote_break_even_amount;
        int64 quote_entry_amount;
        int64 open_bids;
        int64 open_asks;
        int64 settled_pnl;
        uint64 lp_shares;
        uint16 market_index;
    }

    function load_perp_market(bytes32 pubkey) internal view returns (PerpMarketSummary memory) {
        (,bytes32 owner,,,,bytes memory data) = CpiProgram.account_info(pubkey);
        if (owner != DriftPDA.PROGRAM_ID) {
            revert InvalidOwner(owner, DriftPDA.PROGRAM_ID);
        }
        return parse_perp_market(data);
    }

    function load_spot_market(bytes32 pubkey) internal view returns (SpotMarketSummary memory) {
        (,bytes32 owner,,,,bytes memory data) = CpiProgram.account_info(pubkey);
        if (owner != DriftPDA.PROGRAM_ID) {
            revert InvalidOwner(owner, DriftPDA.PROGRAM_ID);
        }
        return parse_spot_market(data);
    }

    function parse_perp_market(bytes memory data) internal pure returns (PerpMarketSummary memory m) {
        if (data.length < PERP_MARKET_MIN_LEN) {
            revert InvalidDataLength("PerpMarket", data.length, PERP_MARKET_MIN_LEN);
        }

        (m.market_index,) = Convert.read_u16le(data, 8);
        (m.status,) = Convert.read_u8(data, 10);
        (m.oracle,) = Convert.read_bytes32(data, 56);
        (m.base_asset_reserve,) = Convert.read_u128le(data, 328);
        (m.quote_asset_reserve,) = Convert.read_u128le(data, 344);
        (m.cumulative_funding_long,) = Convert.read_i128le(data, 592);
        (m.cumulative_funding_short,) = Convert.read_i128le(data, 608);
        (m.last_funding_rate_ts,) = Convert.read_i64le(data, 816);
        (m.open_interest,) = Convert.read_u128le(data, 940);
    }

    function parse_spot_market(bytes memory data) internal pure returns (SpotMarketSummary memory m) {
        if (data.length < SPOT_MARKET_MIN_LEN) {
            revert InvalidDataLength("SpotMarket", data.length, SPOT_MARKET_MIN_LEN);
        }

        uint256 o = 8; // skip discriminator

        (m.oracle, o) = Convert.read_bytes32(data, o);       // 8
        (m.mint, o) = Convert.read_bytes32(data, o);          // 40
        (m.vault, o) = Convert.read_bytes32(data, o);         // 72

        o = 136; // skip name[32] at 104

        (m.deposit_balance, o) = Convert.read_u128le(data, o);             // 136
        (m.borrow_balance, o) = Convert.read_u128le(data, o);              // 152
        (m.cumulative_deposit_interest, o) = Convert.read_u128le(data, o); // 168
        (m.cumulative_borrow_interest,) = Convert.read_u128le(data, o);    // 184

        (m.market_index,) = Convert.read_u16le(data, 288);
        (m.status,) = Convert.read_u8(data, 290);
        (m.decimals,) = Convert.read_u8(data, 292);
    }

    function get_spot_position(bytes memory data, uint8 index) internal pure returns (SpotPosition memory pos) {
        require(index < MAX_SPOT_POSITIONS, "spot index out of range");
        if (data.length < USER_MIN_LEN) {
            revert InvalidDataLength("User", data.length, USER_MIN_LEN);
        }

        uint256 o = USER_SPOT_POSITIONS_OFFSET + uint256(index) * SPOT_POSITION_SIZE;

        (pos.scaled_balance, o) = Convert.read_u64le(data, o);
        (pos.open_bids, o) = Convert.read_i64le(data, o);
        (pos.open_asks, o) = Convert.read_i64le(data, o);
        (pos.cumulative_deposits, o) = Convert.read_i64le(data, o);
        (pos.market_index, o) = Convert.read_u16le(data, o);
        (pos.balance_type,) = Convert.read_u8(data, o);
    }

    function get_perp_position(bytes memory data, uint8 index) internal pure returns (PerpPosition memory pos) {
        require(index < MAX_PERP_POSITIONS, "perp index out of range");
        if (data.length < USER_MIN_LEN) {
            revert InvalidDataLength("User", data.length, USER_MIN_LEN);
        }

        uint256 o = USER_PERP_POSITIONS_OFFSET + uint256(index) * PERP_POSITION_SIZE;

        (pos.last_cumulative_funding_rate, o) = Convert.read_i64le(data, o);
        (pos.base_asset_amount, o) = Convert.read_i64le(data, o);
        (pos.quote_asset_amount, o) = Convert.read_i64le(data, o);
        (pos.quote_break_even_amount, o) = Convert.read_i64le(data, o);
        (pos.quote_entry_amount, o) = Convert.read_i64le(data, o);
        (pos.open_bids, o) = Convert.read_i64le(data, o);
        (pos.open_asks, o) = Convert.read_i64le(data, o);
        (pos.settled_pnl, o) = Convert.read_i64le(data, o);
        (pos.lp_shares, o) = Convert.read_u64le(data, o);

        uint256 market_index_offset = USER_PERP_POSITIONS_OFFSET + uint256(index) * PERP_POSITION_SIZE + 96;
        (pos.market_index,) = Convert.read_u16le(data, market_index_offset);
    }

    function find_perp_position(bytes memory data, uint16 market_index)
        internal
        pure
        returns (PerpPosition memory pos, bool found)
    {
        for (uint8 i = 0; i < MAX_PERP_POSITIONS; i++) {
            PerpPosition memory p = get_perp_position(data, i);
            if (p.market_index == market_index) {
                return (p, true);
            }
        }
        return (pos, false);
    }

    function find_spot_position(bytes memory data, uint16 market_index)
        internal
        pure
        returns (SpotPosition memory pos, bool found)
    {
        for (uint8 i = 0; i < MAX_SPOT_POSITIONS; i++) {
            SpotPosition memory s = get_spot_position(data, i);
            if (s.market_index == market_index) {
                return (s, true);
            }
        }
        return (pos, false);
    }
}
