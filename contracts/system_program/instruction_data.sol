// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library SystemProgramInstructionData {
/*//////////////////////////////////////////////////////////////
                            HELPERS
//////////////////////////////////////////////////////////////*/

    function leU32(uint32 x) internal pure returns (bytes memory b) {
        b = new bytes(4);
        b[0] = bytes1(uint8(x));
        b[1] = bytes1(uint8(x >> 8));
        b[2] = bytes1(uint8(x >> 16));
        b[3] = bytes1(uint8(x >> 24));
    }

    function leU64(uint64 x) internal pure returns (bytes memory b) {
        b = new bytes(8);
        for (uint i = 0; i < 8; i++) {
            b[i] = bytes1(uint8(x >> (8 * i)));
        }
    }

    function encodeString(string memory s) internal pure returns (bytes memory) {
        bytes memory strBytes = bytes(s);
        return abi.encodePacked(
            leU64(uint64(strBytes.length)),
            strBytes
        );
    }

    function encodePubkey(bytes32 pk) internal pure returns (bytes memory) {
        return abi.encodePacked(pk);
    }

    /*//////////////////////////////////////////////////////////////
                        VARIANT SERIALIZERS
    //////////////////////////////////////////////////////////////*/

    // 0
    function createAccount(
    uint64 lamports,
    uint64 space,
    bytes32 owner
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            leU32(0),
            leU64(lamports),
            leU64(space),
            encodePubkey(owner)
        );
    }

    // 1
    function assign(bytes32 owner) internal pure returns (bytes memory)
    {
        return abi.encodePacked(
            leU32(1),
            encodePubkey(owner)
        );
    }

    // 2
    function transfer(uint64 lamports) internal pure returns (bytes memory)
    {
        return abi.encodePacked(
            leU32(2),
            leU64(lamports)
        );
    }

    // 3
    function createAccountWithSeed(
    bytes32 base,
    string memory seed,
    uint64 lamports,
    uint64 space,
    bytes32 owner
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            leU32(3),
            encodePubkey(base),
            encodeString(seed),
            leU64(lamports),
            leU64(space),
            encodePubkey(owner)
        );
    }

    // 4
    function advanceNonceAccount()
    internal pure returns (bytes memory)
    {
        return abi.encodePacked(leU32(4));
    }

    // 5
    function withdrawNonceAccount(uint64 lamports)
    internal pure returns (bytes memory)
    {
        return abi.encodePacked(
            leU32(5),
            leU64(lamports)
        );
    }

    // 6
    function initializeNonceAccount(bytes32 pk)
    internal pure returns (bytes memory)
    {
        return abi.encodePacked(
            leU32(6),
            encodePubkey(pk)
        );
    }

    // 7
    function authorizeNonceAccount(bytes32 pk)
    internal pure returns (bytes memory)
    {
        return abi.encodePacked(
            leU32(7),
            encodePubkey(pk)
        );
    }

    // 8
    function allocate(uint64 space)
    internal pure returns (bytes memory)
    {
        return abi.encodePacked(
            leU32(8),
            leU64(space)
        );
    }

    // 9
    function allocateWithSeed(
    bytes32 base,
    string memory seed,
    uint64 space,
    bytes32 owner
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            leU32(9),
            encodePubkey(base),
            encodeString(seed),
            leU64(space),
            encodePubkey(owner)
        );
    }

    // 10
    function assignWithSeed(
    bytes32 base,
    string memory seed,
    bytes32 owner
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            leU32(10),
            encodePubkey(base),
            encodeString(seed),
            encodePubkey(owner)
        );
    }

    // 11
    function transferWithSeed(
    uint64 lamports,
    string memory fromSeed,
    bytes32 fromOwner
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            leU32(11),
            leU64(lamports),
            encodeString(fromSeed),
            encodePubkey(fromOwner)
        );
    }

    // 12
    function upgradeNonceAccount()
    internal pure returns (bytes memory)
    {
        return abi.encodePacked(leU32(12));
    }
}