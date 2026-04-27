// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AnchorInstruction} from "../AnchorInstruction.sol";

/// @dev Test-only wrapper exposing AnchorInstruction for golden-vector tests.
contract AnchorInstructionWrapper {
    function discriminator(string memory name) external pure returns (bytes8) {
        return AnchorInstruction.discriminator(name);
    }

    function withDiscEmpty(bytes8 disc) external pure returns (bytes memory) {
        return AnchorInstruction.withDisc(disc);
    }

    function withDiscArgs(bytes8 disc, bytes memory args)
        external
        pure
        returns (bytes memory)
    {
        return AnchorInstruction.withDisc(disc, args);
    }

    function optionNone() external pure returns (bytes memory) {
        return AnchorInstruction.optionNone();
    }

    function optionSome(bytes memory value) external pure returns (bytes memory) {
        return AnchorInstruction.optionSome(value);
    }

    function u16le(uint16 x) external pure returns (bytes2) {
        return AnchorInstruction.u16le(x);
    }

    function u32le(uint32 x) external pure returns (bytes4) {
        return AnchorInstruction.u32le(x);
    }

    function i32le(int32 x) external pure returns (bytes4) {
        return AnchorInstruction.i32le(x);
    }

    function u64le(uint64 x) external pure returns (bytes8) {
        return AnchorInstruction.u64le(x);
    }

    function i64le(int64 x) external pure returns (bytes8) {
        return AnchorInstruction.i64le(x);
    }

    function boolle(bool x) external pure returns (bytes1) {
        return AnchorInstruction.boolle(x);
    }
}
