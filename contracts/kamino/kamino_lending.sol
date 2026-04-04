// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "./kamino_lending_lib.sol";
import "./kamino_lending_pda.sol";
import "./kamino_lending_ix.sol";

/// @title KaminoLending
/// @notice High-level Kamino Lending contract providing read-only queries
///         and CPI-based write operations for deposit, withdraw, borrow, and repay.
contract KaminoLending {
    address public immutable cpi_program;

    constructor(address _cpi_program) {
        cpi_program = _cpi_program;
    }

    // ========================
    // Read functions
    // ========================

    /// @notice Load and parse a Kamino Lending reserve account
    /// @param reserve_pubkey Solana pubkey of the reserve
    /// @return Parsed reserve summary
    function get_reserve(bytes32 reserve_pubkey)
        external view returns (KaminoLendingLib.ReserveSummary memory)
    {
        return KaminoLendingLib.load_reserve(reserve_pubkey);
    }

    /// @notice Load and parse a Kamino Lending obligation account
    /// @param obligation_pubkey Solana pubkey of the obligation
    /// @return Parsed obligation summary
    function get_obligation(bytes32 obligation_pubkey)
        external view returns (KaminoLendingLib.ObligationSummary memory)
    {
        return KaminoLendingLib.load_obligation(obligation_pubkey);
    }

    /// @notice Compute the health factor of an obligation
    /// @param obligation_pubkey Solana pubkey of the obligation
    /// @return Health factor scaled by 1e18 (type(uint256).max if no borrows)
    function health_factor(bytes32 obligation_pubkey)
        external view returns (uint256)
    {
        KaminoLendingLib.ObligationSummary memory ob = KaminoLendingLib.load_obligation(obligation_pubkey);
        return KaminoLendingLib.health_factor(ob);
    }

    // ========================
    // Write functions
    // ========================

    /// @notice Deposit liquidity into a reserve and receive obligation collateral
    /// @param amount Amount of liquidity tokens to deposit
    /// @param accounts Remaining accounts for the CPI call
    function deposit(
        uint64 amount,
        ICrossProgramInvocation.AccountMeta[] calldata accounts
    ) external {
        bytes memory data = KaminoLendingIx.build_deposit_data(amount);
        ICrossProgramInvocation(cpi_program).invoke(KaminoLendingLib.PROGRAM_ID, accounts, data);
    }

    /// @notice Withdraw collateral from an obligation and redeem for liquidity
    /// @param collateral_amount Amount of collateral tokens to withdraw
    /// @param accounts Remaining accounts for the CPI call
    function withdraw(
        uint64 collateral_amount,
        ICrossProgramInvocation.AccountMeta[] calldata accounts
    ) external {
        bytes memory data = KaminoLendingIx.build_withdraw_data(collateral_amount);
        ICrossProgramInvocation(cpi_program).invoke(KaminoLendingLib.PROGRAM_ID, accounts, data);
    }

    /// @notice Borrow liquidity from a reserve against obligation collateral
    /// @param amount Amount of liquidity to borrow
    /// @param accounts Remaining accounts for the CPI call
    function borrow(
        uint64 amount,
        ICrossProgramInvocation.AccountMeta[] calldata accounts
    ) external {
        bytes memory data = KaminoLendingIx.build_borrow_data(amount);
        ICrossProgramInvocation(cpi_program).invoke(KaminoLendingLib.PROGRAM_ID, accounts, data);
    }

    /// @notice Repay borrowed liquidity on an obligation
    /// @param amount Amount of liquidity to repay
    /// @param accounts Remaining accounts for the CPI call
    function repay(
        uint64 amount,
        ICrossProgramInvocation.AccountMeta[] calldata accounts
    ) external {
        bytes memory data = KaminoLendingIx.build_repay_data(amount);
        ICrossProgramInvocation(cpi_program).invoke(KaminoLendingLib.PROGRAM_ID, accounts, data);
    }
}
