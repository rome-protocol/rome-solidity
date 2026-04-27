// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISystemProgram, SystemProgram} from "../interface.sol";

/// @title PdaDeriver
/// @notice find_program_address wrapper + typed seed helpers.
/// @dev
///   Thin wrapper over `SystemProgram.find_program_address`. The value is in
///   the typed `seedBytes` overloads and the N-arg `makeSeeds` builders, which
///   replace the 3+ bespoke PDA derive helpers per adapter (Drift's
///   `_userPda`, `_userStatsPda`, `_perpMarketPubkey`; Kamino's
///   `_deriveVanillaObligation`).
library PdaDeriver {
    /// Derive a PDA via the System Program precompile.
    /// Returns (key, bump).
    function derive(bytes32 program, ISystemProgram.Seed[] memory seeds)
        internal
        pure
        returns (bytes32 key, uint8 bump)
    {
        (key, bump) = SystemProgram.find_program_address(program, seeds);
    }

    // ──────────────────────────────────────────────────────────────────
    // Typed seed builders
    // ──────────────────────────────────────────────────────────────────

    function seedBytes(bytes32 pubkey) internal pure returns (ISystemProgram.Seed memory) {
        return ISystemProgram.Seed(abi.encodePacked(pubkey));
    }

    function seedBytes(string memory s) internal pure returns (ISystemProgram.Seed memory) {
        return ISystemProgram.Seed(bytes(s));
    }

    function seedBytes(uint8 x) internal pure returns (ISystemProgram.Seed memory) {
        return ISystemProgram.Seed(abi.encodePacked(x));
    }

    /// u16 seed — written little-endian to match Solana's canonical seed
    /// encoding for u16 indices (market index, sub-account id, etc.).
    function seedBytesU16Le(uint16 x) internal pure returns (ISystemProgram.Seed memory) {
        bytes memory b = new bytes(2);
        b[0] = bytes1(uint8(x));
        b[1] = bytes1(uint8(x >> 8));
        return ISystemProgram.Seed(b);
    }

    function seedBytesRaw(bytes memory raw) internal pure returns (ISystemProgram.Seed memory) {
        return ISystemProgram.Seed(raw);
    }

    // ──────────────────────────────────────────────────────────────────
    // makeSeeds — N-arg array builders
    //
    // Covers 2/3/4/5/6 args. 6-arg matches Kamino's Vanilla obligation
    // scheme:  [tag(u8), id(u8), owner, market, seed1(zero), seed2(zero)]
    // ──────────────────────────────────────────────────────────────────

    function makeSeeds(
        ISystemProgram.Seed memory s1,
        ISystemProgram.Seed memory s2
    ) internal pure returns (ISystemProgram.Seed[] memory seeds) {
        seeds = new ISystemProgram.Seed[](2);
        seeds[0] = s1;
        seeds[1] = s2;
    }

    function makeSeeds(
        ISystemProgram.Seed memory s1,
        ISystemProgram.Seed memory s2,
        ISystemProgram.Seed memory s3
    ) internal pure returns (ISystemProgram.Seed[] memory seeds) {
        seeds = new ISystemProgram.Seed[](3);
        seeds[0] = s1;
        seeds[1] = s2;
        seeds[2] = s3;
    }

    function makeSeeds(
        ISystemProgram.Seed memory s1,
        ISystemProgram.Seed memory s2,
        ISystemProgram.Seed memory s3,
        ISystemProgram.Seed memory s4
    ) internal pure returns (ISystemProgram.Seed[] memory seeds) {
        seeds = new ISystemProgram.Seed[](4);
        seeds[0] = s1;
        seeds[1] = s2;
        seeds[2] = s3;
        seeds[3] = s4;
    }

    function makeSeeds(
        ISystemProgram.Seed memory s1,
        ISystemProgram.Seed memory s2,
        ISystemProgram.Seed memory s3,
        ISystemProgram.Seed memory s4,
        ISystemProgram.Seed memory s5
    ) internal pure returns (ISystemProgram.Seed[] memory seeds) {
        seeds = new ISystemProgram.Seed[](5);
        seeds[0] = s1;
        seeds[1] = s2;
        seeds[2] = s3;
        seeds[3] = s4;
        seeds[4] = s5;
    }

    function makeSeeds(
        ISystemProgram.Seed memory s1,
        ISystemProgram.Seed memory s2,
        ISystemProgram.Seed memory s3,
        ISystemProgram.Seed memory s4,
        ISystemProgram.Seed memory s5,
        ISystemProgram.Seed memory s6
    ) internal pure returns (ISystemProgram.Seed[] memory seeds) {
        seeds = new ISystemProgram.Seed[](6);
        seeds[0] = s1;
        seeds[1] = s2;
        seeds[2] = s3;
        seeds[3] = s4;
        seeds[4] = s5;
        seeds[5] = s6;
    }
}
