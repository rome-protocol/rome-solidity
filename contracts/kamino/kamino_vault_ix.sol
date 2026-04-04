// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../convert.sol";

/// @title KaminoVaultIx
/// @notice Instruction data builders for Kamino Vault CPI calls.
///         Discriminators are derived from Anchor's naming convention:
///         sha256("global:<instruction_name>")[0..8]
library KaminoVaultIx {

    // ========================
    // Deposit
    // ========================

    /// @notice Build instruction data for vault deposit
    /// @param token_a_max Maximum amount of token A to deposit
    /// @param token_b_max Maximum amount of token B to deposit
    /// @return data Serialized instruction data (8-byte discriminator + 2x u64le)
    function build_deposit_data(uint64 token_a_max, uint64 token_b_max) internal pure returns (bytes memory) {
        bytes8 disc = bytes8(sha256("global:deposit"));
        return abi.encodePacked(disc, Convert.u64le(token_a_max), Convert.u64le(token_b_max));
    }

    // ========================
    // Withdraw
    // ========================

    /// @notice Build instruction data for vault withdrawal
    /// @param shares_amount Amount of vault shares to burn
    /// @return data Serialized instruction data (8-byte discriminator + u64le)
    function build_withdraw_data(uint64 shares_amount) internal pure returns (bytes memory) {
        bytes8 disc = bytes8(sha256("global:withdraw"));
        return abi.encodePacked(disc, Convert.u64le(shares_amount));
    }
}
