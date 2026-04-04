// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../rome_evm_account.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {AssociatedSplTokenLib} from "../spl_token/associated_spl_token.sol";
import {JupiterLib} from "../jupiter/jupiter_lib.sol";
import {DriftLib} from "../drift/drift_lib.sol";
import {DriftPDA} from "../drift/drift_pda.sol";
import {DriftIx} from "../drift/drift_instructions.sol";
import {DriftOrderBuilder} from "../drift/drift_order_builder.sol";
import {KaminoLendingLib} from "../kamino/kamino_lending_lib.sol";
import {KaminoLendingIx} from "../kamino/kamino_lending_ix.sol";
import {KaminoVaultLib} from "../kamino/kamino_vault_lib.sol";
import {KaminoVaultIx} from "../kamino/kamino_vault_ix.sol";
import "./ISwap.sol";
import "./ILending.sol";
import "./IPerpetuals.sol";
import "./ILiquidity.sol";

/// @title DeFiRouter
/// @notice Unified DeFi router implementing all protocol interfaces.
///         Delegates to Jupiter, Drift, Kamino protocol libraries.
contract DeFiRouter is ISwap, ILending, IPerpetuals, ILiquidity {
    address public immutable cpi_program;

    constructor(address _cpi_program) {
        cpi_program = _cpi_program;
    }

    // ═══════════════════════════════════════════════════
    //  ISwap
    // ═══════════════════════════════════════════════════

    function swap_with_route(
        bytes32 program_id,
        ICrossProgramInvocation.AccountMeta[] calldata accounts,
        bytes calldata instruction_data
    ) external override {
        ICrossProgramInvocation(cpi_program).invoke(program_id, accounts, instruction_data);
    }

    function swap_direct(
        address pool,
        uint8 in_token,
        uint64 amount_in,
        uint64 min_amount_out
    ) external override {
        // Delegate to pool contract's swap function
        (bool success,) = pool.call(
            abi.encodeWithSignature("swap(uint8,uint64,uint64)", in_token, amount_in, min_amount_out)
        );
        require(success, "swap_direct failed");
    }

    function balance_of(address user, bytes32 mint) external view override returns (uint64) {
        return JupiterLib.token_balance(user, mint);
    }

    // ═══════════════════════════════════════════════════
    //  ILending (Kamino)
    // ═══════════════════════════════════════════════════

    function deposit(
        bytes32 reserve,
        uint64 amount,
        ICrossProgramInvocation.AccountMeta[] calldata remaining_accounts
    ) external override {
        bytes memory data = KaminoLendingIx.build_deposit_data(amount);
        ICrossProgramInvocation(cpi_program).invoke(KaminoLendingLib.PROGRAM_ID, remaining_accounts, data);
    }

    function withdraw(
        bytes32 reserve,
        uint64 collateral_amount,
        ICrossProgramInvocation.AccountMeta[] calldata remaining_accounts
    ) external override {
        bytes memory data = KaminoLendingIx.build_withdraw_data(collateral_amount);
        ICrossProgramInvocation(cpi_program).invoke(KaminoLendingLib.PROGRAM_ID, remaining_accounts, data);
    }

    function borrow(
        bytes32 reserve,
        uint64 amount,
        ICrossProgramInvocation.AccountMeta[] calldata remaining_accounts
    ) external override {
        bytes memory data = KaminoLendingIx.build_borrow_data(amount);
        ICrossProgramInvocation(cpi_program).invoke(KaminoLendingLib.PROGRAM_ID, remaining_accounts, data);
    }

    function repay(
        bytes32 reserve,
        uint64 amount,
        ICrossProgramInvocation.AccountMeta[] calldata remaining_accounts
    ) external override {
        bytes memory data = KaminoLendingIx.build_repay_data(amount);
        ICrossProgramInvocation(cpi_program).invoke(KaminoLendingLib.PROGRAM_ID, remaining_accounts, data);
    }

    function get_reserve_info(bytes32 reserve_pubkey)
        external view override returns (KaminoLendingLib.ReserveSummary memory)
    {
        return KaminoLendingLib.load_reserve(reserve_pubkey);
    }

    function get_obligation_info(bytes32 obligation_pubkey)
        external view override returns (KaminoLendingLib.ObligationSummary memory)
    {
        return KaminoLendingLib.load_obligation(obligation_pubkey);
    }

    function health_factor(bytes32 obligation_pubkey)
        external view override returns (uint256 health_factor_e18)
    {
        KaminoLendingLib.ObligationSummary memory ob = KaminoLendingLib.load_obligation(obligation_pubkey);
        return KaminoLendingLib.health_factor(ob);
    }

    // ═══════════════════════════════════════════════════
    //  IPerpetuals (Drift)
    // ═══════════════════════════════════════════════════

    function deposit_collateral(uint16 spot_market_index, uint64 amount) external override {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);

        DriftLib.SpotMarketSummary memory market = DriftLib.load_spot_market(
            DriftPDA.spot_market_pda(spot_market_index)
        );
        (bytes32 user_ata,) = AssociatedSplTokenLib.associated_token_address(authority, market.mint);

        ICrossProgramInvocation.AccountMeta[] memory accounts =
            DriftIx.build_deposit_accounts(authority, spot_market_index, user_ata);
        bytes memory data = DriftIx.build_deposit_data(spot_market_index, amount, false);

        ICrossProgramInvocation(cpi_program).invoke(DriftPDA.PROGRAM_ID, accounts, data);
    }

    function withdraw_collateral(uint16 spot_market_index, uint64 amount) external override {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);

        DriftLib.SpotMarketSummary memory market = DriftLib.load_spot_market(
            DriftPDA.spot_market_pda(spot_market_index)
        );
        (bytes32 user_ata,) = AssociatedSplTokenLib.associated_token_address(authority, market.mint);

        ICrossProgramInvocation.AccountMeta[] memory accounts =
            DriftIx.build_withdraw_accounts(authority, spot_market_index, user_ata);
        bytes memory data = DriftIx.build_withdraw_data(spot_market_index, amount, false);

        ICrossProgramInvocation(cpi_program).invoke(DriftPDA.PROGRAM_ID, accounts, data);
    }

    function open_market_position(uint16 market_index, uint8 direction, uint64 size) external override {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);

        ICrossProgramInvocation.AccountMeta[] memory accounts =
            DriftIx.build_place_perp_order_accounts(authority);
        bytes memory data = DriftOrderBuilder.market_order(market_index, direction, size);

        ICrossProgramInvocation(cpi_program).invoke(DriftPDA.PROGRAM_ID, accounts, data);
    }

    function place_limit_order(
        uint16 market_index,
        uint8 direction,
        uint64 size,
        uint64 price,
        bool post_only
    ) external override {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);

        ICrossProgramInvocation.AccountMeta[] memory accounts =
            DriftIx.build_place_perp_order_accounts(authority);
        bytes memory data = DriftOrderBuilder.limit_order(
            market_index, direction, size, price, post_only, false
        );

        ICrossProgramInvocation(cpi_program).invoke(DriftPDA.PROGRAM_ID, accounts, data);
    }

    function cancel_order(uint32 order_id) external override {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);

        ICrossProgramInvocation.AccountMeta[] memory accounts =
            DriftIx.build_cancel_order_accounts(authority);
        bytes memory data = DriftIx.build_cancel_order_data(order_id);

        ICrossProgramInvocation(cpi_program).invoke(DriftPDA.PROGRAM_ID, accounts, data);
    }

    function get_position(uint16 market_index)
        external view override returns (DriftLib.PerpPosition memory, bool)
    {
        bytes32 authority = RomeEVMAccount.pda(msg.sender);
        bytes32 user_pubkey = DriftPDA.user_pda(authority, 0);
        (,,,,, bytes memory data) = CpiProgram.account_info(user_pubkey);
        return DriftLib.find_perp_position(data, market_index);
    }

    function get_market_info(uint16 market_index)
        external view override returns (DriftLib.PerpMarketSummary memory)
    {
        bytes32 pubkey = DriftPDA.perp_market_pda(market_index);
        return DriftLib.load_perp_market(pubkey);
    }

    // ═══════════════════════════════════════════════════
    //  ILiquidity (Kamino Vault)
    // ═══════════════════════════════════════════════════

    function deposit_vault(
        bytes32 vault,
        uint64 token_a_max,
        uint64 token_b_max,
        ICrossProgramInvocation.AccountMeta[] calldata remaining_accounts
    ) external override {
        bytes memory data = KaminoVaultIx.build_deposit_data(token_a_max, token_b_max);
        ICrossProgramInvocation(cpi_program).invoke(KaminoVaultLib.PROGRAM_ID, remaining_accounts, data);
    }

    function withdraw_vault(
        bytes32 vault,
        uint64 shares_amount,
        ICrossProgramInvocation.AccountMeta[] calldata remaining_accounts
    ) external override {
        bytes memory data = KaminoVaultIx.build_withdraw_data(shares_amount);
        ICrossProgramInvocation(cpi_program).invoke(KaminoVaultLib.PROGRAM_ID, remaining_accounts, data);
    }

    function get_vault_info(bytes32 vault_pubkey)
        external view override returns (KaminoVaultLib.StrategySummary memory)
    {
        return KaminoVaultLib.load_strategy(vault_pubkey);
    }
}
