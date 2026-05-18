// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../damm_v1_pool.sol";

/// @title DAMMv1VaultParserHarness
/// @notice Test wrapper exposing DAMMv1Lib.parse_vault + VAULT_MIN_LEN as
///         external calls so unit tests can verify the slice constant
///         matches the parser's actual byte consumption.
contract DAMMv1VaultParserHarness {
    function parseVault(bytes memory data) external pure returns (
        uint8 enabled,
        uint8 vaultBump,
        uint8 tokenVaultBump,
        uint64 totalAmount,
        bytes32 tokenVault,
        bytes32 feeVault,
        bytes32 tokenMint,
        bytes32 lpMint
    ) {
        DAMMv1Lib.VaultState memory v = DAMMv1Lib.parse_vault(data);
        return (
            v.enabled,
            v.bumps.vault_bump,
            v.bumps.token_vault_bump,
            v.total_amount,
            v.token_vault,
            v.fee_vault,
            v.token_mint,
            v.lp_mint
        );
    }

    function vaultMinLen() external pure returns (uint256) {
        return DAMMv1Lib.VAULT_MIN_LEN;
    }
}
