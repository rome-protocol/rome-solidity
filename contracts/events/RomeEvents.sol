// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title RomeEvents — structured events readable from Solana programs
/// @notice Persists events to a ring-buffer PDA owned by rome-evm-private AND
///         fires a standard EVM LOGn so ethers.js / eth_getLogs / Blockscout
///         remain compatible. The ring PDA seed uses `msg.sender`, resolved
///         program-side in the precompile — a contract can only write into
///         its own ring.
library RomeEvents {
    address constant EVENT_LOG_PRECOMPILE =
        address(0xff00000000000000000000000000000000000009);

    bytes1 constant SEL_EMIT         = 0x01;
    bytes1 constant SEL_INIT_RING    = 0x02;
    bytes1 constant SEL_RING_HEADER  = 0x03;

    error EmitFailed();
    error InitRingFailed();
    error RingHeaderFailed();
    error TooManyTopics();
    error DataTooLarge();

    /// Emit a structured event. Fires a standard LOGn AND appends to the ring PDA.
    /// `topics` excludes topic0 and holds up to 3 entries.
    /// `data` up to 65,535 bytes (will be truncated to the ring's data_cap if larger).
    function emitEvent(
        bytes32 topic0,
        bytes32[] memory topics,
        bytes memory data
    ) internal {
        if (topics.length > 3) revert TooManyTopics();
        if (data.length > type(uint16).max) revert DataTooLarge();

        bytes memory buf = abi.encodePacked(
            SEL_EMIT,
            topic0,
            uint8(topics.length)
        );
        for (uint256 i = 0; i < topics.length; i++) {
            buf = abi.encodePacked(buf, topics[i]);
        }
        buf = abi.encodePacked(buf, _u16LE(uint16(data.length)), data);

        (bool ok, ) = EVENT_LOG_PRECOMPILE.call(buf);
        if (!ok) revert EmitFailed();
    }

    /// Initialize the ring PDA with custom capacity / data_cap.
    /// Must be called BEFORE the first emitEvent from this contract.
    function initRing(uint32 capacity, uint16 dataCap) internal {
        bytes memory buf = abi.encodePacked(
            SEL_INIT_RING,
            _u32LE(capacity),
            _u16LE(dataCap)
        );
        (bool ok, ) = EVENT_LOG_PRECOMPILE.call(buf);
        if (!ok) revert InitRingFailed();
    }

    /// Read the current ring header for a given emitter. View-only.
    function ringHeader(address emitter)
        internal view
        returns (uint32 capacity, uint16 dataCap, uint32 head, uint64 count)
    {
        bytes memory buf = abi.encodePacked(SEL_RING_HEADER, bytes20(emitter));
        (bool ok, bytes memory ret) = EVENT_LOG_PRECOMPILE.staticcall(buf);
        if (!ok || ret.length < 18) revert RingHeaderFailed();
        capacity = _u32LEFromBytes(ret, 0);
        dataCap  = _u16LEFromBytes(ret, 4);
        head     = _u32LEFromBytes(ret, 6);
        count    = _u64LEFromBytes(ret, 10);
    }

    // ---- LE helpers (little-endian for Solana-side byte layouts) ----

    function _u16LE(uint16 v) private pure returns (bytes memory) {
        bytes memory b = new bytes(2);
        b[0] = bytes1(uint8(v));
        b[1] = bytes1(uint8(v >> 8));
        return b;
    }

    function _u32LE(uint32 v) private pure returns (bytes memory) {
        bytes memory b = new bytes(4);
        b[0] = bytes1(uint8(v));
        b[1] = bytes1(uint8(v >> 8));
        b[2] = bytes1(uint8(v >> 16));
        b[3] = bytes1(uint8(v >> 24));
        return b;
    }

    function _u16LEFromBytes(bytes memory b, uint256 off) private pure returns (uint16) {
        return uint16(uint8(b[off])) | (uint16(uint8(b[off + 1])) << 8);
    }

    function _u32LEFromBytes(bytes memory b, uint256 off) private pure returns (uint32) {
        return uint32(uint8(b[off]))
            | (uint32(uint8(b[off + 1])) << 8)
            | (uint32(uint8(b[off + 2])) << 16)
            | (uint32(uint8(b[off + 3])) << 24);
    }

    function _u64LEFromBytes(bytes memory b, uint256 off) private pure returns (uint64) {
        uint64 r;
        for (uint256 i = 0; i < 8; i++) {
            r |= uint64(uint8(b[off + i])) << uint64(8 * i);
        }
        return r;
    }
}
