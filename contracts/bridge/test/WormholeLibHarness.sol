// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {WormholeTokenBridgeLib} from "../IWormholeTokenBridge.sol";
import {ICrossProgramInvocation} from "../../interface.sol";

/// @notice Test harness exposing WormholeTokenBridgeLib transfer_native internals
///         for network-independent unit tests (mirrors CCTPV2LibHarness). Also
///         exposes the proven transfer_wrapped encoder so the native encoding can
///         be asserted equal-modulo-the-tag against it.
contract WormholeLibHarness {
    function encodeNative(
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain
    ) external pure returns (bytes memory) {
        return WormholeTokenBridgeLib.encodeTransferNative(WormholeTokenBridgeLib.TransferParams({
            amount: amount,
            fee: fee,
            targetAddress: targetAddress,
            targetChain: targetChain,
            nonce: nonce
        }));
    }

    function encodeWrapped(
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain
    ) external pure returns (bytes memory) {
        return WormholeTokenBridgeLib.encodeTransferTokens(WormholeTokenBridgeLib.TransferParams({
            amount: amount,
            fee: fee,
            targetAddress: targetAddress,
            targetChain: targetChain,
            nonce: nonce
        }));
    }

    function buildNative(WormholeTokenBridgeLib.TransferNativeAccounts memory a)
        external
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory)
    {
        return WormholeTokenBridgeLib.buildTransferNativeAccounts(a);
    }
}
