// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {Convert} from "../convert.sol";
import "../rome_evm_account.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {AssociatedSplTokenLib} from "../spl_token/associated_spl_token.sol";
import {DriftPDA} from "./drift_pda.sol";
import {DriftLib} from "./drift_lib.sol";

library DriftIx {
    bytes32 internal constant TOKEN_PROGRAM = SplTokenLib.SPL_TOKEN_PROGRAM;

    // --- Instruction data builders ---

    function build_deposit_data(uint16 market_index, uint64 amount, bool reduce_only)
        internal
        pure
        returns (bytes memory)
    {
        bytes8 disc = bytes8(sha256(bytes("global:deposit")));
        return abi.encodePacked(
            disc,
            Convert.u16le(market_index),
            Convert.u64le(amount),
            reduce_only ? uint8(1) : uint8(0)
        );
    }

    function build_withdraw_data(uint16 market_index, uint64 amount, bool reduce_only)
        internal
        pure
        returns (bytes memory)
    {
        bytes8 disc = bytes8(sha256(bytes("global:withdraw")));
        return abi.encodePacked(
            disc,
            Convert.u16le(market_index),
            Convert.u64le(amount),
            reduce_only ? uint8(1) : uint8(0)
        );
    }

    function build_cancel_order_data(uint32 order_id)
        internal
        pure
        returns (bytes memory)
    {
        bytes8 disc = bytes8(sha256(bytes("global:cancel_order")));
        if (order_id == 0) {
            // Option<u32>::None
            return abi.encodePacked(disc, uint8(0));
        } else {
            // Option<u32>::Some(order_id)
            return abi.encodePacked(
                disc,
                uint8(1),
                uint8(order_id & 0xFF),
                uint8((order_id >> 8) & 0xFF),
                uint8((order_id >> 16) & 0xFF),
                uint8((order_id >> 24) & 0xFF)
            );
        }
    }

    // --- Account meta builders ---

    function build_deposit_accounts(bytes32 user_authority, uint16 spot_market_index, bytes32 user_token_account)
        internal
        view
        returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        bytes32 state = DriftPDA.state_pda();
        bytes32 user = DriftPDA.user_pda(user_authority, 0);
        bytes32 user_stats = DriftPDA.user_stats_pda(user_authority);
        bytes32 spot_market = DriftPDA.spot_market_pda(spot_market_index);
        bytes32 spot_vault = DriftPDA.spot_market_vault_pda(spot_market_index);

        DriftLib.SpotMarketSummary memory market = DriftLib.load_spot_market(spot_market);

        metas = new ICrossProgramInvocation.AccountMeta[](9);
        metas[0] = ICrossProgramInvocation.AccountMeta(state, false, false);
        metas[1] = ICrossProgramInvocation.AccountMeta(user, false, true);
        metas[2] = ICrossProgramInvocation.AccountMeta(user_stats, false, true);
        metas[3] = ICrossProgramInvocation.AccountMeta(user_authority, true, false);
        metas[4] = ICrossProgramInvocation.AccountMeta(spot_vault, false, true);
        metas[5] = ICrossProgramInvocation.AccountMeta(user_token_account, false, true);
        metas[6] = ICrossProgramInvocation.AccountMeta(TOKEN_PROGRAM, false, false);
        metas[7] = ICrossProgramInvocation.AccountMeta(spot_market, false, true);
        metas[8] = ICrossProgramInvocation.AccountMeta(market.oracle, false, false);
    }

    function build_withdraw_accounts(bytes32 user_authority, uint16 spot_market_index, bytes32 user_token_account)
        internal
        view
        returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        bytes32 state = DriftPDA.state_pda();
        bytes32 user = DriftPDA.user_pda(user_authority, 0);
        bytes32 user_stats = DriftPDA.user_stats_pda(user_authority);
        bytes32 spot_market = DriftPDA.spot_market_pda(spot_market_index);
        bytes32 spot_vault = DriftPDA.spot_market_vault_pda(spot_market_index);
        bytes32 signer = DriftPDA.drift_signer();

        DriftLib.SpotMarketSummary memory market = DriftLib.load_spot_market(spot_market);

        metas = new ICrossProgramInvocation.AccountMeta[](10);
        metas[0] = ICrossProgramInvocation.AccountMeta(state, false, false);
        metas[1] = ICrossProgramInvocation.AccountMeta(user, false, true);
        metas[2] = ICrossProgramInvocation.AccountMeta(user_stats, false, true);
        metas[3] = ICrossProgramInvocation.AccountMeta(user_authority, true, false);
        metas[4] = ICrossProgramInvocation.AccountMeta(spot_vault, false, true);
        metas[5] = ICrossProgramInvocation.AccountMeta(signer, false, false);
        metas[6] = ICrossProgramInvocation.AccountMeta(user_token_account, false, true);
        metas[7] = ICrossProgramInvocation.AccountMeta(TOKEN_PROGRAM, false, false);
        metas[8] = ICrossProgramInvocation.AccountMeta(spot_market, false, true);
        metas[9] = ICrossProgramInvocation.AccountMeta(market.oracle, false, false);
    }

    function build_place_perp_order_accounts(bytes32 user_authority)
        internal
        view
        returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        bytes32 state = DriftPDA.state_pda();
        bytes32 user = DriftPDA.user_pda(user_authority, 0);

        metas = new ICrossProgramInvocation.AccountMeta[](3);
        metas[0] = ICrossProgramInvocation.AccountMeta(state, false, false);
        metas[1] = ICrossProgramInvocation.AccountMeta(user, false, true);
        metas[2] = ICrossProgramInvocation.AccountMeta(user_authority, true, false);
    }

    function build_cancel_order_accounts(bytes32 user_authority)
        internal
        view
        returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        bytes32 state = DriftPDA.state_pda();
        bytes32 user = DriftPDA.user_pda(user_authority, 0);

        metas = new ICrossProgramInvocation.AccountMeta[](3);
        metas[0] = ICrossProgramInvocation.AccountMeta(state, false, false);
        metas[1] = ICrossProgramInvocation.AccountMeta(user, false, true);
        metas[2] = ICrossProgramInvocation.AccountMeta(user_authority, true, false);
    }
}
