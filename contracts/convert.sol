// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library Convert {
    struct COptionBytes32 {
        bool is_some;
        bytes32 value;
    }

    error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value);
    error InvalidCOptionTag(uint32 tag);

    function read_coption_bytes32(bytes memory data, uint256 offset)
    internal
    pure
    returns (COptionBytes32 memory value, uint256 newOffset)
    {
        uint32 tag;
        (tag, offset) = read_u32le(data, offset);

        bytes32 key;
        (key, offset) = read_bytes32(data, offset);

        if (tag == 0) {
            value = COptionBytes32({is_some: false, value: bytes32(0)});
        } else if (tag == 1) {
            value = COptionBytes32({is_some: true, value: key});
        } else {
            revert InvalidCOptionTag(tag);
        }

        return (value, offset);
    }

    function read_u8(bytes memory data, uint256 offset)
    internal
    pure
    returns (uint8 value, uint256 newOffset)
    {
        require(offset + 1 <= data.length, "oob u8");
        value = uint8(data[offset]);
        return (value, offset + 1);
    }

    function read_u32le(bytes memory data, uint256 offset)
    internal
    pure
    returns (uint32 value, uint256 newOffset)
    {
        require(offset + 4 <= data.length, "oob u32");
        value = uint32(uint8(data[offset]))
            | (uint32(uint8(data[offset + 1])) << 8)
            | (uint32(uint8(data[offset + 2])) << 16)
            | (uint32(uint8(data[offset + 3])) << 24);
        return (value, offset + 4);
    }

    function read_u64le(bytes memory data, uint256 offset)
    internal
    pure
    returns (uint64 value, uint256 newOffset)
    {
        require(offset + 8 <= data.length, "oob u64");
        value = uint64(uint8(data[offset]))
            | (uint64(uint8(data[offset + 1])) << 8)
            | (uint64(uint8(data[offset + 2])) << 16)
            | (uint64(uint8(data[offset + 3])) << 24)
            | (uint64(uint8(data[offset + 4])) << 32)
            | (uint64(uint8(data[offset + 5])) << 40)
            | (uint64(uint8(data[offset + 6])) << 48)
            | (uint64(uint8(data[offset + 7])) << 56);
        return (value, offset + 8);
    }

    function read_i64le(bytes memory data, uint256 offset)
    internal
    pure
    returns (int64 value, uint256 newOffset)
    {
        uint64 unsigned;
        (unsigned, newOffset) = read_u64le(data, offset);
        value = int64(unsigned);
    }

    function read_i128le(bytes memory data, uint256 offset)
    internal
    pure
    returns (int128 value, uint256 newOffset)
    {
        require(offset + 16 <= data.length, "oob i128");
        uint128 lo;
        uint128 hi;
        // Read low 8 bytes
        for (uint256 i = 0; i < 8; i++) {
            lo |= uint128(uint8(data[offset + i])) << uint128(i * 8);
        }
        // Read high 8 bytes
        for (uint256 i = 0; i < 8; i++) {
            hi |= uint128(uint8(data[offset + 8 + i])) << uint128(i * 8);
        }
        uint128 unsigned = lo | (hi << 64);
        value = int128(unsigned);
        newOffset = offset + 16;
    }

    function read_bytes32(bytes memory data, uint256 offset)
    internal
    pure
    returns (bytes32 value, uint256 newOffset)
    {
        require(offset + 32 <= data.length, "oob bytes32");
        assembly {
            value := mload(add(add(data, 0x20), offset))
        }
        return (value, offset + 32);
    }

    function u64le(uint64 x) internal pure returns (bytes8) {
        return bytes8(
            (uint64(x & 0x00000000000000FF) << 56)
            | (uint64(x & 0x000000000000FF00) << 40)
            | (uint64(x & 0x0000000000FF0000) << 24)
            | (uint64(x & 0x00000000FF000000) << 8)
            | (uint64(x & 0x000000FF00000000) >> 8)
            | (uint64(x & 0x0000FF0000000000) >> 24)
            | (uint64(x & 0x00FF000000000000) >> 40)
            | (uint64(x & 0xFF00000000000000) >> 56)
        );
    }

    function bytes32_to_bytes(bytes32 src) internal pure returns (bytes memory) {
        bytes memory dst = new bytes(32);

        assembly {
            mstore(add(dst, 32), src)
        }
        return dst;
    }

    function chain_id_le(uint chain_id) internal pure returns (bytes memory ) {
        return abi.encodePacked(
            uint8( chain_id),
            uint8(chain_id >> 8 ),
            uint8(chain_id >> 16),
            uint8(chain_id >> 24),
            uint8(chain_id >> 32),
            uint8(chain_id >> 40),
            uint8(chain_id >> 48),
            uint8(chain_id >> 56)
        );
    }

    function uint_to_bytes(uint src) public pure returns (bytes memory) {
        bytes memory dst = new bytes(32);

        assembly {
            mstore(add(dst, 32), src)
        }
        return dst;
    }

    function bytes_to_bytes32(bytes memory src) public pure returns (bytes32) {
        bytes32 dst;

        assembly {
            dst := mload(add(src, 32))
        }
        return  dst;
    }

    function revert_msg(bytes memory _returnData) public pure returns (string memory) {
        if (_returnData.length < 68) return '';

        bytes memory mes;
        assembly {
            mes := add(_returnData, 0x04)
        }
        return abi.decode(mes, (string));
    }

    function to_uint64(uint256 value) public pure returns (uint64) {
        if (value > type(uint64).max) {
            revert SafeCastOverflowedUintDowncast(64, value);
        }
        return uint64(value);
    }
}