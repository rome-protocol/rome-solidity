// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../WormholeTokenBridgeEncoding.sol";

/// @title WormholeEncodingHarness
/// @notice Test wrapper that exposes WormholeTokenBridgeEncoding's internal library
///         functions as external calls for unit testing.
contract WormholeEncodingHarness {
    function encodeTransferNative(
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain
    ) external pure returns (bytes memory) {
        return WormholeTokenBridgeEncoding.encodeTransferNative(nonce, amount, fee, targetAddress, targetChain);
    }

    function encodeTransferWrapped(
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain
    ) external pure returns (bytes memory) {
        return WormholeTokenBridgeEncoding.encodeTransferWrapped(nonce, amount, fee, targetAddress, targetChain);
    }

    function encodeCompleteNative() external pure returns (bytes memory) {
        return WormholeTokenBridgeEncoding.encodeCompleteNative();
    }

    function encodeCompleteWrapped() external pure returns (bytes memory) {
        return WormholeTokenBridgeEncoding.encodeCompleteWrapped();
    }

    function encodeTransferPayload(
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain
    ) external pure returns (bytes memory) {
        return WormholeTokenBridgeEncoding.encodeTransferPayload(nonce, amount, fee, targetAddress, targetChain);
    }
}
