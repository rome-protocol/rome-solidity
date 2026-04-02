// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../convert.sol";

/// @title KaminoVaultLib
/// @notice Strategy account parser for Kamino Vault (liquidity vaults).
///         Reads Solana account data via CPI precompile and deserializes
///         Borsh-encoded Kamino Vault program strategy accounts.
library KaminoVaultLib {
    /// Kamino Vault program ID (kvauTFR8qm1dhniz6pYuBZkuene3Hfrs1VQhVRgCNrr)
    bytes32 public constant PROGRAM_ID = 0x0b40902394dddf4fc8a4f6c0002a0a7b99b8cd717c38e145b0fa11ffe32b8567;

    uint256 constant STRATEGY_MIN_LEN = 400;

    // ========================
    // Errors
    // ========================

    error InvalidDataLength(uint256 actual, uint256 expected);

    // ========================
    // Structs
    // ========================

    struct StrategySummary {
        bytes32 admin_authority;
        bytes32 global_config;
        bytes32 token_a_mint;
        bytes32 token_b_mint;
        bytes32 token_a_vault;
        bytes32 token_b_vault;
        bytes32 pool;
        bytes32 shares_mint;
        uint64 shares_issued;
        uint64 token_a_amount;
        uint64 token_b_amount;
    }

    // ========================
    // Account loader
    // ========================

    /// @notice Load and parse a Kamino Vault strategy account
    /// @param pubkey Solana pubkey of the strategy account
    /// @return summary Parsed strategy fields
    function load_strategy(bytes32 pubkey) internal view returns (StrategySummary memory summary) {
        (,bytes32 owner,,,,bytes memory data) = CpiProgram.account_info(pubkey);
        require(owner == PROGRAM_ID, "KaminoVaultLib: invalid strategy owner");
        return parse_strategy(data);
    }

    // ========================
    // Strategy parser
    // ========================

    /// @notice Parse strategy account data
    /// @dev Layout:
    ///   [0..8]     discriminator
    ///   [8..40]    admin_authority (Pubkey)
    ///   [40..72]   global_config (Pubkey)
    ///   [72..104]  token_a_mint (Pubkey)
    ///   [104..136] token_b_mint (Pubkey)
    ///   [136..168] token_a_vault (Pubkey)
    ///   [168..200] token_b_vault (Pubkey)
    ///   [200..232] pool (Pubkey)
    ///   [232..264] position (Pubkey) — skipped
    ///   [264..272] shares_mint_decimals (u64) — skipped
    ///   [272..304] shares_mint (Pubkey)
    ///   [304..312] shares_issued (u64)
    ///   [312..320] token_a_amount (u64)
    ///   [320..328] token_b_amount (u64)
    function parse_strategy(bytes memory data) internal pure returns (StrategySummary memory s) {
        if (data.length < STRATEGY_MIN_LEN) {
            revert InvalidDataLength(data.length, STRATEGY_MIN_LEN);
        }

        uint256 offset = 8; // skip discriminator

        // 7 sequential Pubkey fields
        (s.admin_authority, offset) = Convert.read_bytes32(data, offset);
        (s.global_config, offset) = Convert.read_bytes32(data, offset);
        (s.token_a_mint, offset) = Convert.read_bytes32(data, offset);
        (s.token_b_mint, offset) = Convert.read_bytes32(data, offset);
        (s.token_a_vault, offset) = Convert.read_bytes32(data, offset);
        (s.token_b_vault, offset) = Convert.read_bytes32(data, offset);
        (s.pool, offset) = Convert.read_bytes32(data, offset);

        // skip position (32 bytes) + shares_mint_decimals (8 bytes)
        offset += 32 + 8;

        // shares_mint, shares_issued, token_a_amount, token_b_amount
        (s.shares_mint, offset) = Convert.read_bytes32(data, offset);
        (s.shares_issued, offset) = Convert.read_u64le(data, offset);
        (s.token_a_amount, offset) = Convert.read_u64le(data, offset);
        (s.token_b_amount, offset) = Convert.read_u64le(data, offset);
    }
}
