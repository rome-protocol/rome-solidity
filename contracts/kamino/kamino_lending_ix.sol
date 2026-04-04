// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../convert.sol";

/// @title KaminoLendingIx
/// @notice Instruction data builders for Kamino Lending CPI calls.
///         Discriminators are derived from Anchor's naming convention:
///         sha256("global:<instruction_name>")[0..8]
library KaminoLendingIx {

    /// @notice Account keys for the deposit instruction
    struct DepositAccounts {
        bytes32 owner;
        bytes32 obligation;
        bytes32 lending_market;
        bytes32 lending_market_authority;
        bytes32 reserve;
        bytes32 reserve_liquidity_mint;
        bytes32 reserve_liquidity_supply;
        bytes32 reserve_collateral_mint;
        bytes32 reserve_destination_collateral;
        bytes32 user_source_liquidity;
        bytes32 user_destination_collateral;
        bytes32 collateral_token_program;
        bytes32 liquidity_token_program;
    }

    // ========================
    // Deposit
    // ========================

    /// @notice Build instruction data for deposit_reserve_liquidity_and_obligation_collateral
    /// @param amount Amount of liquidity tokens to deposit
    /// @return data Serialized instruction data (8-byte discriminator + u64le amount)
    function build_deposit_data(uint64 amount) internal pure returns (bytes memory) {
        bytes8 disc = bytes8(sha256("global:deposit_reserve_liquidity_and_obligation_collateral"));
        return abi.encodePacked(disc, Convert.u64le(amount));
    }

    /// @notice Build accounts array for deposit instruction
    /// @param a Deposit account keys
    /// @return accounts 13-element AccountMeta array
    function build_deposit_accounts(DepositAccounts memory a)
        internal pure returns (ICrossProgramInvocation.AccountMeta[] memory accounts)
    {
        accounts = new ICrossProgramInvocation.AccountMeta[](13);
        accounts[0]  = ICrossProgramInvocation.AccountMeta(a.owner, true, false);
        accounts[1]  = ICrossProgramInvocation.AccountMeta(a.obligation, false, true);
        accounts[2]  = ICrossProgramInvocation.AccountMeta(a.lending_market, false, false);
        accounts[3]  = ICrossProgramInvocation.AccountMeta(a.lending_market_authority, false, false);
        accounts[4]  = ICrossProgramInvocation.AccountMeta(a.reserve, false, true);
        accounts[5]  = ICrossProgramInvocation.AccountMeta(a.reserve_liquidity_mint, false, true);
        accounts[6]  = ICrossProgramInvocation.AccountMeta(a.reserve_liquidity_supply, false, true);
        accounts[7]  = ICrossProgramInvocation.AccountMeta(a.reserve_collateral_mint, false, true);
        accounts[8]  = ICrossProgramInvocation.AccountMeta(a.reserve_destination_collateral, false, true);
        accounts[9]  = ICrossProgramInvocation.AccountMeta(a.user_source_liquidity, false, true);
        accounts[10] = ICrossProgramInvocation.AccountMeta(a.user_destination_collateral, false, true);
        accounts[11] = ICrossProgramInvocation.AccountMeta(a.collateral_token_program, false, false);
        accounts[12] = ICrossProgramInvocation.AccountMeta(a.liquidity_token_program, false, false);
    }

    // ========================
    // Withdraw
    // ========================

    /// @notice Build instruction data for withdraw_obligation_collateral_and_redeem_reserve_collateral
    /// @param collateral_amount Amount of collateral tokens to withdraw
    /// @return data Serialized instruction data
    function build_withdraw_data(uint64 collateral_amount) internal pure returns (bytes memory) {
        bytes8 disc = bytes8(sha256("global:withdraw_obligation_collateral_and_redeem_reserve_collateral"));
        return abi.encodePacked(disc, Convert.u64le(collateral_amount));
    }

    // ========================
    // Borrow
    // ========================

    /// @notice Build instruction data for borrow_obligation_liquidity
    /// @param amount Amount of liquidity to borrow
    /// @return data Serialized instruction data
    function build_borrow_data(uint64 amount) internal pure returns (bytes memory) {
        bytes8 disc = bytes8(sha256("global:borrow_obligation_liquidity"));
        return abi.encodePacked(disc, Convert.u64le(amount));
    }

    // ========================
    // Repay
    // ========================

    /// @notice Build instruction data for repay_obligation_liquidity
    /// @param amount Amount of liquidity to repay
    /// @return data Serialized instruction data
    function build_repay_data(uint64 amount) internal pure returns (bytes memory) {
        bytes8 disc = bytes8(sha256("global:repay_obligation_liquidity"));
        return abi.encodePacked(disc, Convert.u64le(amount));
    }
}
