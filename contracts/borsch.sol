// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library Borsch {
    error InvalidBool(uint8 value);
    error BorshOutOfBounds(uint256 offset, uint256 need, uint256 total);
    error InvalidOptionTag(uint8 value);

    function read_bool(bytes memory data, uint256 offset)
    internal
    pure
    returns (bool value, uint256 newOffset)
    {
        uint8 b;
        ensure(data, offset, 1);
        b = uint8(data[offset]);
        offset += 1;

        if (b == 0) return (false, offset);
        if (b == 1) return (true, offset);

        revert InvalidBool(b);
    }

    function read_pubkey(bytes memory data, uint256 offset)
    internal
    pure
    returns (bytes32 value, uint256 newOffset)
    {
        return read_bytes32(data, offset);
    }

    function read_bytes32(bytes memory data, uint256 offset)
    internal
    pure
    returns (bytes32 value, uint256 newOffset)
    {
        ensure(data, offset, 32);
        assembly {
            value := mload(add(add(data, 0x20), offset))
        }
        return (value, offset + 32);
    }

    function read_bytes8(bytes memory data, uint256 offset)
    internal
    pure
    returns (bytes8 value, uint256 newOffset)
    {
        ensure(data, offset, 8);
        uint64 tmp;
        for (uint256 i = 0; i < 8; i++) {
            tmp |= uint64(uint8(data[offset + i])) << (8 * (7 - i));
        }
        value = bytes8(tmp);
        return (value, offset + 8);
    }

    function read_u16(bytes memory data, uint256 offset)
    internal
    pure
    returns (uint16 value, uint256 newOffset)
    {
        ensure(data, offset, 2);
        value =
            uint16(uint8(data[offset])) |
            (uint16(uint8(data[offset + 1])) << 8);
        return (value, offset + 2);
    }

    function read_u32(bytes memory data, uint256 offset)
    internal
    pure
    returns (uint32 value, uint256 newOffset)
    {
        ensure(data, offset, 4);
        value =
            uint32(uint8(data[offset])) |
            (uint32(uint8(data[offset + 1])) << 8) |
            (uint32(uint8(data[offset + 2])) << 16) |
            (uint32(uint8(data[offset + 3])) << 24);
        return (value, offset + 4);
    }

    function read_u64(bytes memory data, uint256 offset)
    internal
    pure
    returns (uint64 value, uint256 newOffset)
    {
        ensure(data, offset, 8);
        value =
            uint64(uint8(data[offset])) |
            (uint64(uint8(data[offset + 1])) << 8) |
            (uint64(uint8(data[offset + 2])) << 16) |
            (uint64(uint8(data[offset + 3])) << 24) |
            (uint64(uint8(data[offset + 4])) << 32) |
            (uint64(uint8(data[offset + 5])) << 40) |
            (uint64(uint8(data[offset + 6])) << 48) |
            (uint64(uint8(data[offset + 7])) << 56);
        return (value, offset + 8);
    }

    function read_string(bytes memory data, uint256 offset)
    internal
    pure
    returns (string memory value, uint256 newOffset)
    {
        uint32 len;
        (len, offset) = read_u32(data, offset);
        ensure(data, offset, len);

        bytes memory buf = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            buf[i] = data[offset + i];
        }

        value = string(buf);
        return (value, offset + len);
    }

    // =========================
    // Option parsers
    // =========================

    function read_option_u8(bytes memory data, uint256 offset)
    internal
    pure
    returns (bool hasValue, uint8 value, uint256 newOffset)
    {
        uint8 tag;
        ensure(data, offset, 1);
        tag = uint8(data[offset]);
        offset += 1;

        if (tag == 0) {
            return (false, 0, offset);
        }
        if (tag == 1) {
            ensure(data, offset, 1);
            value = uint8(data[offset]);
            offset += 1;
            return (true, value, offset);
        }

        revert InvalidOptionTag(tag);
    }

    function read_option_pubkey(bytes memory data, uint256 offset)
    internal
    pure
    returns (bool hasValue, bytes32 value, uint256 newOffset)
    {
        uint8 tag;
        ensure(data, offset, 1);
        tag = uint8(data[offset]);
        offset += 1;

        if (tag == 0) {
            return (false, bytes32(0), offset);
        }
        if (tag == 1) {
            (value, offset) = read_pubkey(data, offset);
            return (true, value, offset);
        }

        revert InvalidOptionTag(tag);
    }

    // =========================
    // Bounds check
    // =========================

    function ensure(bytes memory data, uint256 offset, uint256 need) internal pure {
        if (offset + need > data.length) {
            revert BorshOutOfBounds(offset, need, data.length);
        }
    }
}