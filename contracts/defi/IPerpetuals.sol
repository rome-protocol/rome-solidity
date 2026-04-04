// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DriftLib} from "../drift/drift_lib.sol";

/// @title IPerpetuals
/// @notice Protocol-agnostic perpetuals interface
/// @dev Backed by Drift v2
interface IPerpetuals {
    function deposit_collateral(uint16 spot_market_index, uint64 amount) external;
    function withdraw_collateral(uint16 spot_market_index, uint64 amount) external;

    function open_market_position(uint16 market_index, uint8 direction, uint64 size) external;
    function place_limit_order(uint16 market_index, uint8 direction, uint64 size, uint64 price, bool post_only) external;
    function cancel_order(uint32 order_id) external;

    function get_position(uint16 market_index) external view returns (DriftLib.PerpPosition memory, bool);
    function get_market_info(uint16 market_index) external view returns (DriftLib.PerpMarketSummary memory);
}
