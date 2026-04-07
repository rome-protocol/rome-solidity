// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../TransferHookBase.sol";

/// @title KYCHook
/// @notice Example compliance hook that enforces KYC (Know Your Customer) requirements.
/// @dev Maintains a mapping of approved addresses. Both source and destination
///      transfer authorities must be approved, or the transfer is blocked.
contract KYCHook is TransferHookBase {
    /// @notice Mapping of Solana pubkey (bytes32) to KYC approval status
    mapping(bytes32 => bool) public approved;

    /// @notice The admin who can add/remove approved addresses
    address public owner;

    error TransferBlocked(string reason);
    error OnlyOwner();

    event AddressApproved(bytes32 indexed account);
    event AddressRevoked(bytes32 indexed account);

    constructor(address _router) TransferHookBase(_router) {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) {
            revert OnlyOwner();
        }
        _;
    }

    /// @notice Approve an address for KYC
    function approveAddress(bytes32 account) external onlyOwner {
        approved[account] = true;
        emit AddressApproved(account);
    }

    /// @notice Revoke KYC approval
    function revokeAddress(bytes32 account) external onlyOwner {
        approved[account] = false;
        emit AddressRevoked(account);
    }

    /// @notice Called on every transfer. Reverts if source or destination not KYC approved.
    /// @dev Only callable by the Meta-Hook Router (enforced by onlyRouter modifier)
    function onTransfer(
        bytes32 source,
        bytes32 mint,
        bytes32 destination,
        bytes32 authority,
        uint64 amount
    ) external override onlyRouter {
        if (!approved[source]) {
            revert TransferBlocked("KYC_REQUIRED_SOURCE");
        }
        if (!approved[destination]) {
            revert TransferBlocked("KYC_REQUIRED_DESTINATION");
        }

        emit HookExecuted(source, destination, mint, amount);
    }
}
