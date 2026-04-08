// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title ITransferHook
/// @notice Interface for Solidity transfer hook contracts executed via Rome Meta-Hook Router.
/// @dev Implementations of this interface are called on every token transfer by the
///      Meta-Hook Router via Rome EVM's DoEvmCallback instruction.
///      The hook MUST revert to block the transfer. Returning normally means approval.
interface ITransferHook {
    /// @notice Called on every token transfer. MUST revert to block the transfer.
    /// @param source Source token account (Solana pubkey as bytes32)
    /// @param mint Token mint (Solana pubkey as bytes32)
    /// @param destination Destination token account (Solana pubkey as bytes32)
    /// @param authority Transfer authority (Solana pubkey as bytes32)
    /// @param amount Transfer amount (raw token units)
    function onTransfer(
        bytes32 source,
        bytes32 mint,
        bytes32 destination,
        bytes32 authority,
        uint64 amount
    ) external;
}
