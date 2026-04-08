// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ITransferHook.sol";

/// @title TransferHookBase
/// @notice Abstract base contract for Solidity transfer hooks.
/// @dev Provides the onlyRouter modifier to verify msg.sender is the
///      Meta-Hook Router's derived EVM address.
abstract contract TransferHookBase is ITransferHook {
    /// @notice The expected msg.sender — derived from the Meta-Hook Router PDA
    ///         via keccak256(router_program_id ++ "callback_authority")[12..]
    address public immutable router;

    /// @notice Emitted when a transfer hook is executed
    event HookExecuted(
        bytes32 indexed source,
        bytes32 indexed destination,
        bytes32 mint,
        uint64 amount
    );

    error OnlyRouter(address caller, address expectedRouter);

    constructor(address _router) {
        require(_router != address(0), "Router address cannot be zero");
        router = _router;
    }

    /// @notice Ensures only the Meta-Hook Router can call this function
    modifier onlyRouter() {
        if (msg.sender != router) {
            revert OnlyRouter(msg.sender, router);
        }
        _;
    }
}
