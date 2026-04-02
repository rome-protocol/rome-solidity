// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../convert.sol";

/// @title KaminoLendingLib
/// @notice Reserve and Obligation parsers for Kamino Lending (KLend).
///         Reads Solana account data via CPI precompile and deserializes
///         Borsh-encoded Kamino Lending program accounts.
library KaminoLendingLib {
    /// Kamino Lending program ID (KLend2g3cP87ber8LQsmXrCY6ZadMZRQv5ioanSDE9p)
    bytes32 public constant PROGRAM_ID = 0x04b2acb11258cce36828e7b98f45472b7ce8244701bfd68a06eda8e810cd524d;

    uint256 constant RESERVE_MIN_LEN = 8616;
    uint256 constant OBLIGATION_MIN_LEN = 200;

    // ========================
    // Errors
    // ========================

    error InvalidDataLength(string account_type, uint256 actual, uint256 expected);

    // ========================
    // Structs
    // ========================

    struct ReserveSummary {
        bytes32 lending_market;
        bytes32 liquidity_mint;
        bytes32 liquidity_supply_vault;
        bytes32 liquidity_oracle;
        uint64 available_amount;
        uint128 borrowed_amount_sf;
        uint128 cumulative_borrow_rate_sf;
        bytes32 collateral_mint;
        uint64 collateral_supply;
        uint8 loan_to_value_pct;
        uint8 liquidation_threshold;
        uint8 status;
    }

    struct ObligationSummary {
        bytes32 lending_market;
        bytes32 owner;
        uint128 deposited_value_sf;
        uint128 borrowed_value_sf;
        uint128 allowed_borrow_value_sf;
        uint128 unhealthy_borrow_value_sf;
        uint32 deposit_count;
        uint32 borrow_count;
    }

    struct ObligationDeposit {
        bytes32 deposit_reserve;
        uint64 deposited_amount;
        uint128 market_value_sf;
    }

    struct ObligationBorrow {
        bytes32 borrow_reserve;
        uint128 cumulative_borrow_rate_sf;
        uint128 borrowed_amount_sf;
        uint128 market_value_sf;
    }

    // ========================
    // Account loaders
    // ========================

    /// @notice Load and parse a Kamino Lending reserve account
    /// @param pubkey Solana pubkey of the reserve account
    /// @return summary Parsed reserve fields
    function load_reserve(bytes32 pubkey) internal view returns (ReserveSummary memory summary) {
        (,bytes32 owner,,,,bytes memory data) = CpiProgram.account_info(pubkey);
        require(owner == PROGRAM_ID, "KaminoLendingLib: invalid reserve owner");
        return parse_reserve(data);
    }

    /// @notice Load and parse a Kamino Lending obligation account
    /// @param pubkey Solana pubkey of the obligation account
    /// @return summary Parsed obligation fields
    function load_obligation(bytes32 pubkey) internal view returns (ObligationSummary memory summary) {
        (,bytes32 owner,,,,bytes memory data) = CpiProgram.account_info(pubkey);
        require(owner == PROGRAM_ID, "KaminoLendingLib: invalid obligation owner");
        return parse_obligation_summary(data);
    }

    // ========================
    // Reserve parser
    // ========================

    /// @notice Parse reserve account data
    /// @dev Layout:
    ///   [0..8]    discriminator
    ///   [8..16]   version (u64)
    ///   [16..25]  last_update (9 bytes: slot u64 + stale u8)
    ///   [25..57]  lending_market (Pubkey)
    ///   [57..89]  liquidity_mint (Pubkey)
    ///   [89..121] liquidity_supply_vault (Pubkey)
    ///   [121..153] liquidity_oracle (Pubkey)  (fee_receiver skipped, oracle after)
    ///   ... sequential liquidity fields ...
    ///   [520..552] collateral_mint
    ///   [700]     status
    ///   [701]     loan_to_value_pct
    ///   [702]     liquidation_threshold
    function parse_reserve(bytes memory data) internal pure returns (ReserveSummary memory s) {
        if (data.length < RESERVE_MIN_LEN) {
            revert InvalidDataLength("Reserve", data.length, RESERVE_MIN_LEN);
        }

        uint256 offset = 8 + 8 + 9; // discriminator + version + last_update

        // lending_market
        (s.lending_market, offset) = Convert.read_bytes32(data, offset);

        // liquidity fields: mint, supply_vault
        (s.liquidity_mint, offset) = Convert.read_bytes32(data, offset);
        (s.liquidity_supply_vault, offset) = Convert.read_bytes32(data, offset);

        // liquidity_oracle (next pubkey after supply_vault, skipping fee_receiver)
        // fee_receiver is a Pubkey (32 bytes)
        offset += 32; // skip fee_receiver
        (s.liquidity_oracle, offset) = Convert.read_bytes32(data, offset);

        // available_amount (u64)
        (s.available_amount, offset) = Convert.read_u64le(data, offset);

        // borrowed_amount_sf (u128)
        (s.borrowed_amount_sf, offset) = Convert.read_u128le(data, offset);

        // cumulative_borrow_rate_sf (u128)
        (s.cumulative_borrow_rate_sf, offset) = Convert.read_u128le(data, offset);

        // Jump to collateral_mint at offset 520
        offset = 520;
        (s.collateral_mint, offset) = Convert.read_bytes32(data, offset);

        // collateral_supply (u64) follows collateral_mint
        (s.collateral_supply, offset) = Convert.read_u64le(data, offset);

        // Jump to status/ltv/liquidation at offset 700
        offset = 700;
        (s.status, offset) = Convert.read_u8(data, offset);
        (s.loan_to_value_pct, offset) = Convert.read_u8(data, offset);
        (s.liquidation_threshold, offset) = Convert.read_u8(data, offset);
    }

    // ========================
    // Obligation parser
    // ========================

    /// @notice Parse obligation account data for summary fields
    /// @dev Layout:
    ///   [0..8]    discriminator
    ///   [8..16]   tag (u64)
    ///   [16..25]  last_update (9 bytes)
    ///   [25..57]  lending_market (Pubkey)
    ///   [57..89]  owner (Pubkey)
    ///   [89..93]  deposit_count (u32)
    ///   ... deposit entries (56 bytes each) ...
    ///   ... borrow_count (u32) ...
    ///   ... borrow entries (80 bytes each) ...
    ///   ... 4 x u128 aggregate values ...
    function parse_obligation_summary(bytes memory data) internal pure returns (ObligationSummary memory s) {
        if (data.length < OBLIGATION_MIN_LEN) {
            revert InvalidDataLength("Obligation", data.length, OBLIGATION_MIN_LEN);
        }

        uint256 offset = 8 + 8 + 9; // discriminator + tag + last_update

        // lending_market
        (s.lending_market, offset) = Convert.read_bytes32(data, offset);

        // owner
        (s.owner, offset) = Convert.read_bytes32(data, offset);

        // deposit_count (u32)
        (s.deposit_count, offset) = Convert.read_u32le(data, offset);

        // skip deposit entries: 56 bytes each
        offset += uint256(s.deposit_count) * 56;

        // borrow_count (u32)
        (s.borrow_count, offset) = Convert.read_u32le(data, offset);

        // skip borrow entries: 80 bytes each
        offset += uint256(s.borrow_count) * 80;

        // 4 aggregate u128 values
        (s.deposited_value_sf, offset) = Convert.read_u128le(data, offset);
        (s.borrowed_value_sf, offset) = Convert.read_u128le(data, offset);
        (s.allowed_borrow_value_sf, offset) = Convert.read_u128le(data, offset);
        (s.unhealthy_borrow_value_sf, offset) = Convert.read_u128le(data, offset);
    }

    // ========================
    // Health factor
    // ========================

    /// @notice Compute the health factor of an obligation
    /// @dev Returns type(uint256).max if no borrows (fully healthy).
    ///      Otherwise: unhealthy_borrow_value_sf * 1e18 / borrowed_value_sf
    /// @param ob Parsed obligation summary
    /// @return Health factor scaled by 1e18
    function health_factor(ObligationSummary memory ob) internal pure returns (uint256) {
        if (ob.borrowed_value_sf == 0) {
            return type(uint256).max;
        }
        return uint256(ob.unhealthy_borrow_value_sf) * 1e18 / uint256(ob.borrowed_value_sf);
    }
}
