// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title RomeBridgeEvents
/// @notice Shared event definitions for Rome Bridge withdrawal and paymaster flows.
interface RomeBridgeEvents {
    /// @notice Emitted when a user initiates a withdrawal from the Rome EVM to Ethereum.
    /// @param user             EVM address of the withdrawing user.
    /// @param mint             SPL mint (bytes32 pubkey) of the token being withdrawn.
    /// @param amount           Token amount (in SPL decimals).
    /// @param ethereumRecipient Destination address on Ethereum.
    /// @param path             Bridge path: 0 = CCTP, 1 = Wormhole.
    event Withdrawn(
        address indexed user,
        bytes32 indexed mint,
        uint256 amount,
        address ethereumRecipient,
        uint8 path
    );

    /// @notice Emitted when the paymaster sponsors a user transaction.
    /// @param user            EVM address of the sponsored user.
    /// @param remainingBudget Remaining sponsorship budget after this transaction.
    /// @param target          Contract address that was called on behalf of the user.
    event PaymasterSponsored(
        address indexed user,
        uint8 remainingBudget,
        address indexed target
    );

    /// @notice Emitted when a user settles an inbound-bridge gas-split by
    ///         converting rUSDC (or any chain-gas-mint wrapper) into native
    ///         Rome gas via the `unwrap_spl_to_gas` precompile. Mirror of
    ///         `Withdrawn`; indexers watch both events to reconcile CCTP /
    ///         Wormhole attestation records against on-Rome settlement.
    /// @param user            EVM address that received the gas.
    /// @param mint            SPL mint (bytes32 pubkey) whose wrapper was unwrapped.
    /// @param wrapperAmount   Mint-unit tokens pulled from user's wrapper balance.
    /// @param gasAmountWei    Wei credited to user's Rome Balance PDA (18-dec).
    event SettledInbound(
        address indexed user,
        bytes32 indexed mint,
        uint256 wrapperAmount,
        uint256 gasAmountWei
    );
}
