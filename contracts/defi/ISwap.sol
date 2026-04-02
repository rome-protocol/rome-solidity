// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";

/// @title ISwap
/// @notice Protocol-agnostic token swap interface
/// @dev Backed by Jupiter (arbitrary routes) and Meteora (direct pool swaps)
interface ISwap {
    /// @notice Execute a swap using a pre-computed route (Jupiter-style)
    /// @param program_id The DEX program to invoke
    /// @param accounts Full account list for the swap instruction
    /// @param instruction_data Serialized instruction data (includes discriminator)
    function swap_with_route(
        bytes32 program_id,
        ICrossProgramInvocation.AccountMeta[] calldata accounts,
        bytes calldata instruction_data
    ) external;

    /// @notice Execute a direct pool swap (Meteora-style)
    /// @param pool The pool contract address
    /// @param in_token 0=TokenA, 1=TokenB
    /// @param amount_in Amount of input tokens
    /// @param min_amount_out Minimum output (slippage protection)
    function swap_direct(
        address pool,
        uint8 in_token,
        uint64 amount_in,
        uint64 min_amount_out
    ) external;

    /// @notice Read caller's token balance
    function balance_of(address user, bytes32 mint) external view returns (uint64);
}
