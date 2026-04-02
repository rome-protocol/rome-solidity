// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {Convert} from "../convert.sol";
import "../rome_evm_account.sol";
import {DriftPDA} from "./drift_pda.sol";
import {DriftLib} from "./drift_lib.sol";
import {DriftIx} from "./drift_instructions.sol";
import {DriftOrderBuilder} from "./drift_order_builder.sol";

contract DriftController {
    address public immutable factory;
    address public immutable cpi_program;

    constructor(address _cpi_program) {
        factory = msg.sender;
        cpi_program = _cpi_program;
    }

    // --- Read operations ---

    function get_perp_market(uint16 market_index)
        external
        view
        returns (DriftLib.PerpMarketSummary memory)
    {
        bytes32 pubkey = DriftPDA.perp_market_pda(market_index);
        return DriftLib.load_perp_market(pubkey);
    }

    function get_spot_market(uint16 market_index)
        external
        view
        returns (DriftLib.SpotMarketSummary memory)
    {
        bytes32 pubkey = DriftPDA.spot_market_pda(market_index);
        return DriftLib.load_spot_market(pubkey);
    }

    function get_perp_position(uint16 market_index)
        external
        view
        returns (DriftLib.PerpPosition memory pos, bool found)
    {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);
        bytes32 user_pubkey = DriftPDA.user_pda(authority, 0);
        (,,,,, bytes memory data) = CpiProgram.account_info(user_pubkey);
        return DriftLib.find_perp_position(data, market_index);
    }

    function get_spot_position(uint16 market_index)
        external
        view
        returns (DriftLib.SpotPosition memory pos, bool found)
    {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);
        bytes32 user_pubkey = DriftPDA.user_pda(authority, 0);
        (,,,,, bytes memory data) = CpiProgram.account_info(user_pubkey);
        return DriftLib.find_spot_position(data, market_index);
    }

    // --- Write operations ---

    function deposit(uint16 spot_market_index, uint64 amount, bool reduce_only, bytes32 user_token_account)
        external
    {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);
        ICrossProgramInvocation.AccountMeta[] memory metas =
            DriftIx.build_deposit_accounts(authority, spot_market_index, user_token_account);
        bytes memory data = DriftIx.build_deposit_data(spot_market_index, amount, reduce_only);
        ICrossProgramInvocation(cpi_program).invoke(DriftPDA.PROGRAM_ID, metas, data);
    }

    function withdraw(uint16 spot_market_index, uint64 amount, bool reduce_only, bytes32 user_token_account)
        external
    {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);
        ICrossProgramInvocation.AccountMeta[] memory metas =
            DriftIx.build_withdraw_accounts(authority, spot_market_index, user_token_account);
        bytes memory data = DriftIx.build_withdraw_data(spot_market_index, amount, reduce_only);
        ICrossProgramInvocation(cpi_program).invoke(DriftPDA.PROGRAM_ID, metas, data);
    }

    function open_market_position(uint16 market_index, uint8 direction, uint64 base_asset_amount)
        external
    {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);
        ICrossProgramInvocation.AccountMeta[] memory metas =
            DriftIx.build_place_perp_order_accounts(authority);
        bytes memory data = DriftOrderBuilder.market_order(market_index, direction, base_asset_amount);
        ICrossProgramInvocation(cpi_program).invoke(DriftPDA.PROGRAM_ID, metas, data);
    }

    function place_limit_order(
        uint16 market_index,
        uint8 direction,
        uint64 base_asset_amount,
        uint64 price,
        bool post_only,
        bool reduce_only
    )
        external
    {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);
        ICrossProgramInvocation.AccountMeta[] memory metas =
            DriftIx.build_place_perp_order_accounts(authority);
        bytes memory data = DriftOrderBuilder.limit_order(
            market_index, direction, base_asset_amount, price, post_only, reduce_only
        );
        ICrossProgramInvocation(cpi_program).invoke(DriftPDA.PROGRAM_ID, metas, data);
    }

    function cancel_order(uint32 order_id)
        external
    {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);
        ICrossProgramInvocation.AccountMeta[] memory metas =
            DriftIx.build_cancel_order_accounts(authority);
        bytes memory data = DriftIx.build_cancel_order_data(order_id);
        ICrossProgramInvocation(cpi_program).invoke(DriftPDA.PROGRAM_ID, metas, data);
    }
}
