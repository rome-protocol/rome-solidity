// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DelegatecallRelay
/// @notice Test-only harness for Halborn #511: DELEGATECALLs a target
///         wrapper's bytecode from this contract's own storage context, so
///         `address(this)` inside the wrapper's code resolves to THIS
///         contract, not the wrapper's real deployed address, while
///         `msg.sender` stays whatever called `relay*` (preserved through
///         DELEGATECALL). This is the identity-confusion shape the rome-evm
///         gate defends against.
/// @dev    Never deploy outside a test/integration harness.
contract DelegatecallRelay {
    error RelayFailed(bytes result);

    /// @notice Delegatecalls `target.transfer(to, value)`.
    function relayTransfer(address target, address to, uint256 value) external returns (bool) {
        (bool ok, bytes memory result) = target.delegatecall(
            abi.encodeWithSignature("transfer(address,uint256)", to, value)
        );
        if (!ok) revert RelayFailed(result);
        return abi.decode(result, (bool));
    }

    /// @notice Delegatecalls `target.approve(spender, value)`.
    function relayApprove(address target, address spender, uint256 value) external returns (bool) {
        (bool ok, bytes memory result) = target.delegatecall(
            abi.encodeWithSignature("approve(address,uint256)", spender, value)
        );
        if (!ok) revert RelayFailed(result);
        return abi.decode(result, (bool));
    }

    /// @notice Delegatecalls `target.mint_to(to, value)`.
    function relayMintTo(address target, address to, uint256 value) external returns (bool) {
        (bool ok, bytes memory result) = target.delegatecall(
            abi.encodeWithSignature("mint_to(address,uint256)", to, value)
        );
        if (!ok) revert RelayFailed(result);
        return abi.decode(result, (bool));
    }
}
