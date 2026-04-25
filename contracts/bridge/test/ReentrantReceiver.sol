// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SPL_ERC20} from "../../erc20spl/erc20spl.sol";

interface IRomeBridgeInbound {
    function settleInbound(uint256 wrapperAmount) external returns (uint256);
}

/// @title ReentrantReceiver
/// @notice Test-only contract whose `receive()` re-enters
///         RomeBridgeInbound.settleInbound during the gas forward. Exists
///         purely to verify the ReentrancyGuard on the inbound contract
///         (audit hardening item A2).
///
/// @dev On the first hop, the inbound contract calls `call{value}` on
///      this contract — that lands in `receive()`, which re-invokes
///      `settleInbound`. With a guard in place the re-entry must revert
///      ("ReentrancyGuardReentrantCall"). Without one, the second call
///      would proceed to spend whatever wrapper allowance is left.
contract ReentrantReceiver {
    IRomeBridgeInbound public immutable inbound;
    SPL_ERC20 public immutable wrapper;
    uint256 public immutable replayAmount;
    bool public attempted;
    bytes public lastRevertData;

    constructor(IRomeBridgeInbound _inbound, SPL_ERC20 _wrapper, uint256 _replayAmount) {
        inbound = _inbound;
        wrapper = _wrapper;
        replayAmount = _replayAmount;
    }

    /// @notice Call this from the test to fire the first settleInbound. The
    ///         contract must already hold a wrapper balance + have approved
    ///         `inbound` for at least `replayAmount * 2` worth.
    function trigger(uint256 amount) external returns (uint256) {
        return inbound.settleInbound(amount);
    }

    receive() external payable {
        if (attempted) return; // only re-enter once
        attempted = true;
        // Try to re-enter the inbound contract. If the guard is in place
        // this call reverts with ReentrancyGuardReentrantCall and we
        // capture the revert data; otherwise we silently proceed (the
        // test then asserts the second call did not happen).
        try inbound.settleInbound(replayAmount) {
            // Re-entry succeeded — guard absent or broken. Test will
            // detect by observing wrapper balance change.
        } catch (bytes memory revertData) {
            lastRevertData = revertData;
        }
    }
}
