// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {KaminoVaultLib} from "../kamino/kamino_vault_lib.sol";

/// @title ILiquidity
/// @notice Protocol-agnostic LP provision interface
/// @dev Backed by Kamino Liquidity (vaults) and Meteora (DAMM pools)
interface ILiquidity {
    function deposit_vault(bytes32 vault, uint64 token_a_max, uint64 token_b_max,
        ICrossProgramInvocation.AccountMeta[] calldata remaining_accounts) external;

    function withdraw_vault(bytes32 vault, uint64 shares_amount,
        ICrossProgramInvocation.AccountMeta[] calldata remaining_accounts) external;

    function get_vault_info(bytes32 vault_pubkey)
        external view returns (KaminoVaultLib.StrategySummary memory);
}
