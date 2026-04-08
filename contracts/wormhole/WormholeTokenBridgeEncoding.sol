// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title WormholeTokenBridgeEncoding
/// @notice Instruction **data** bytes for the Solana Wormhole Token Bridge program, matching
library WormholeTokenBridgeEncoding {
    /// @dev Must match `TokenBridgeInstruction` in the TS coder.
    uint8 internal constant IX_COMPLETE_NATIVE = 2;
    uint8 internal constant IX_COMPLETE_WRAPPED = 3;
    uint8 internal constant IX_TRANSFER_WRAPPED = 4;
    uint8 internal constant IX_TRANSFER_NATIVE = 5;

    uint256 internal constant TRANSFER_PAYLOAD_LEN = 54;

    function encodeCompleteNative() internal pure returns (bytes memory) {
        bytes memory out = new bytes(1);
        out[0] = bytes1(IX_COMPLETE_NATIVE);
        return out;
    }

    function encodeCompleteWrapped() internal pure returns (bytes memory) {
        bytes memory out = new bytes(1);
        out[0] = bytes1(IX_COMPLETE_WRAPPED);
        return out;
    }

    /// @notice `transferNative` / `transferWrapped` shared payload: 54 bytes after discriminator.
    function encodeTransferPayload(
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain
    ) internal pure returns (bytes memory payload) {
        payload = new bytes(TRANSFER_PAYLOAD_LEN);
        _writeU32LE(payload, 0, nonce);
        _writeU64LE(payload, 4, amount);
        _writeU64LE(payload, 12, fee);
        for (uint256 i = 0; i < 32; i++) {
            payload[20 + i] = targetAddress[i];
        }
        _writeU16LE(payload, 52, targetChain);
    }

    function encodeTransferNative(
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain
    ) internal pure returns (bytes memory) {
        return _encodeTransfer(IX_TRANSFER_NATIVE, nonce, amount, fee, targetAddress, targetChain);
    }

    function encodeTransferWrapped(
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain
    ) internal pure returns (bytes memory) {
        return _encodeTransfer(IX_TRANSFER_WRAPPED, nonce, amount, fee, targetAddress, targetChain);
    }

    function _encodeTransfer(
        uint8 discriminator,
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain
    ) private pure returns (bytes memory) {
        bytes memory payload = encodeTransferPayload(nonce, amount, fee, targetAddress, targetChain);
        bytes memory out = new bytes(1 + payload.length);
        out[0] = bytes1(discriminator);
        for (uint256 i = 0; i < payload.length; i++) {
            out[1 + i] = payload[i];
        }
        return out;
    }

    function _writeU32LE(bytes memory b, uint256 offset, uint32 v) private pure {
        b[offset] = bytes1(uint8(v));
        b[offset + 1] = bytes1(uint8(v >> 8));
        b[offset + 2] = bytes1(uint8(v >> 16));
        b[offset + 3] = bytes1(uint8(v >> 24));
    }

    function _writeU16LE(bytes memory b, uint256 offset, uint16 v) private pure {
        b[offset] = bytes1(uint8(v));
        b[offset + 1] = bytes1(uint8(v >> 8));
    }

    function _writeU64LE(bytes memory b, uint256 offset, uint64 v) private pure {
        for (uint256 i = 0; i < 8; i++) {
            b[offset + i] = bytes1(uint8(v >> (8 * i)));
        }
    }
}
