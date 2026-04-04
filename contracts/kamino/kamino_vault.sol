// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "./kamino_vault_lib.sol";
import "./kamino_vault_ix.sol";

/// @title KaminoVault
/// @notice High-level Kamino Vault contract providing read-only strategy queries
///         and CPI-based write operations for deposit and withdraw.
contract KaminoVault {
    address public immutable cpi_program;

    constructor(address _cpi_program) {
        cpi_program = _cpi_program;
    }

    // ========================
    // Read functions
    // ========================

    /// @notice Load and parse a Kamino Vault strategy account
    /// @param strategy_pubkey Solana pubkey of the strategy
    /// @return Parsed strategy summary
    function get_strategy(bytes32 strategy_pubkey)
        external view returns (KaminoVaultLib.StrategySummary memory)
    {
        return KaminoVaultLib.load_strategy(strategy_pubkey);
    }

    // ========================
    // Write functions
    // ========================

    /// @notice Deposit tokens into a Kamino Vault strategy
    /// @param token_a_max Maximum amount of token A to deposit
    /// @param token_b_max Maximum amount of token B to deposit
    /// @param accounts Remaining accounts for the CPI call
    function deposit(
        uint64 token_a_max,
        uint64 token_b_max,
        ICrossProgramInvocation.AccountMeta[] calldata accounts
    ) external {
        bytes memory data = KaminoVaultIx.build_deposit_data(token_a_max, token_b_max);
        ICrossProgramInvocation(cpi_program).invoke(KaminoVaultLib.PROGRAM_ID, accounts, data);
    }

    /// @notice Withdraw from a Kamino Vault strategy by burning shares
    /// @param shares_amount Amount of vault shares to burn
    /// @param accounts Remaining accounts for the CPI call
    function withdraw(
        uint64 shares_amount,
        ICrossProgramInvocation.AccountMeta[] calldata accounts
    ) external {
        bytes memory data = KaminoVaultIx.build_withdraw_data(shares_amount);
        ICrossProgramInvocation(cpi_program).invoke(KaminoVaultLib.PROGRAM_ID, accounts, data);
    }
}
