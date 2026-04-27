// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISystemProgram} from "../../interface.sol";
import {PdaDeriver} from "../PdaDeriver.sol";

/// @dev Test-only wrapper exposing PdaDeriver for tests. Note: `derive` is
///      `view` because the underlying `SystemProgram.find_program_address`
///      talks to the precompile — tests run against hardhatMainnet without a
///      live precompile, so the derive paths are covered indirectly via the
///      UserPda wrapper (which runs on live Rome EVM).
contract PdaDeriverWrapper {
    function seedBytesPubkey(bytes32 pubkey) external pure returns (bytes memory) {
        return PdaDeriver.seedBytes(pubkey).item;
    }

    function seedBytesString(string memory s) external pure returns (bytes memory) {
        return PdaDeriver.seedBytes(s).item;
    }

    function seedBytesU8(uint8 x) external pure returns (bytes memory) {
        return PdaDeriver.seedBytes(x).item;
    }

    function seedBytesU16Le(uint16 x) external pure returns (bytes memory) {
        return PdaDeriver.seedBytesU16Le(x).item;
    }

    function makeSeeds2(bytes32 a, bytes32 b) external pure returns (uint256) {
        ISystemProgram.Seed[] memory seeds = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(a),
            PdaDeriver.seedBytes(b)
        );
        return seeds.length;
    }

    function makeSeeds3(bytes32 a, bytes32 b, bytes32 c)
        external
        pure
        returns (uint256)
    {
        ISystemProgram.Seed[] memory seeds = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(a),
            PdaDeriver.seedBytes(b),
            PdaDeriver.seedBytes(c)
        );
        return seeds.length;
    }

    function makeSeeds6(
        uint8 tag,
        uint8 id,
        bytes32 owner,
        bytes32 market
    ) external pure returns (uint256) {
        bytes32 zero = bytes32(0);
        ISystemProgram.Seed[] memory seeds = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(tag),
            PdaDeriver.seedBytes(id),
            PdaDeriver.seedBytes(owner),
            PdaDeriver.seedBytes(market),
            PdaDeriver.seedBytes(zero),
            PdaDeriver.seedBytes(zero)
        );
        return seeds.length;
    }
}
