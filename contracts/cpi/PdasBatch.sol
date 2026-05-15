// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISystemProgram, ICrossProgramInvocation, CpiProgram} from "../interface.sol";

/// @title PdasBatch
/// @notice Multi-PDA derivation library — wraps the `pdas_batch_derive`
///         CPI shortcut selector (`0x944336f8` on the CPI precompile at
///         `0xFF…08`). Use this when a contract derives 2+ PDAs in a row
///         against the same Solana program.
///
/// @dev    Counterpart to `PdaDeriver` (which wraps the single-PDA
///         `SystemProgram.find_program_address` on `0xFF…07`). Distinct
///         precompiles → distinct call paths → distinct libraries.
///         The old single-PDA path stays available; new multi-PDA call
///         sites should use this.
///
///         CU saving: one syscall instead of N two-hops; ~50–80K CU per
///         PDA over a single `find_program_address` baseline. Measured
///         numbers post-deploy land in
///         `rome-specs/active/technical/2026-05-14-rome-primitive-cu-baseline.md`.
///
/// @dev    Hard limits enforced by the precompile (see
///         `rome-evm-private/program/src/non_evm/derive_helpers.rs`):
///           - N ≤ 16   (max seed groups)
///           - M ≤ 8    (max inner seeds per group)
///           - len ≤ 32 (max bytes per seed — Solana hard cap)
///         Over-limit triggers an on-chain revert.
///
/// @dev    Output ordering is deterministic: `result[i]` corresponds to
///         `seedGroups[i]`. Every downstream consumer (rome-sdk TS +
///         Rust mirrors, off-chain previews) relies on this contract.
library PdasBatch {

    /// Derive N PDAs against `programId` in a single precompile call.
    /// Returns one (pda, bump) pair per input group, in order.
    function derive(
        ISystemProgram.Seed[][] memory seedGroups,
        bytes32 programId
    ) internal view returns (ICrossProgramInvocation.PdaWithBump[] memory) {
        return CpiProgram.pdas_batch_derive(_unwrap(seedGroups), programId);
    }

    /// Convenience: 2 PDAs in one call.
    function pair(
        ISystemProgram.Seed[] memory seedsA,
        ISystemProgram.Seed[] memory seedsB,
        bytes32 programId
    )
        internal
        view
        returns (
            ICrossProgramInvocation.PdaWithBump memory a,
            ICrossProgramInvocation.PdaWithBump memory b
        )
    {
        ISystemProgram.Seed[][] memory groups = new ISystemProgram.Seed[][](2);
        groups[0] = seedsA;
        groups[1] = seedsB;
        ICrossProgramInvocation.PdaWithBump[] memory out =
            CpiProgram.pdas_batch_derive(_unwrap(groups), programId);
        a = out[0];
        b = out[1];
    }

    /// Convenience: 3 PDAs in one call.
    function triplet(
        ISystemProgram.Seed[] memory seedsA,
        ISystemProgram.Seed[] memory seedsB,
        ISystemProgram.Seed[] memory seedsC,
        bytes32 programId
    )
        internal
        view
        returns (
            ICrossProgramInvocation.PdaWithBump memory a,
            ICrossProgramInvocation.PdaWithBump memory b,
            ICrossProgramInvocation.PdaWithBump memory c
        )
    {
        ISystemProgram.Seed[][] memory groups = new ISystemProgram.Seed[][](3);
        groups[0] = seedsA;
        groups[1] = seedsB;
        groups[2] = seedsC;
        ICrossProgramInvocation.PdaWithBump[] memory out =
            CpiProgram.pdas_batch_derive(_unwrap(groups), programId);
        a = out[0];
        b = out[1];
        c = out[2];
    }

    /// Convenience: 4 PDAs in one call.
    function quad(
        ISystemProgram.Seed[] memory seedsA,
        ISystemProgram.Seed[] memory seedsB,
        ISystemProgram.Seed[] memory seedsC,
        ISystemProgram.Seed[] memory seedsD,
        bytes32 programId
    )
        internal
        view
        returns (
            ICrossProgramInvocation.PdaWithBump memory a,
            ICrossProgramInvocation.PdaWithBump memory b,
            ICrossProgramInvocation.PdaWithBump memory c,
            ICrossProgramInvocation.PdaWithBump memory d
        )
    {
        ISystemProgram.Seed[][] memory groups = new ISystemProgram.Seed[][](4);
        groups[0] = seedsA;
        groups[1] = seedsB;
        groups[2] = seedsC;
        groups[3] = seedsD;
        ICrossProgramInvocation.PdaWithBump[] memory out =
            CpiProgram.pdas_batch_derive(_unwrap(groups), programId);
        a = out[0];
        b = out[1];
        c = out[2];
        d = out[3];
    }

    /// Internal: flatten `Seed[][]` to `bytes[][]` for the precompile wire.
    /// Each `Seed.item` is copied by reference (no deep copy of the bytes).
    function _unwrap(ISystemProgram.Seed[][] memory groups)
        private
        pure
        returns (bytes[][] memory out)
    {
        uint256 n = groups.length;
        out = new bytes[][](n);
        for (uint256 i = 0; i < n; ++i) {
            uint256 m = groups[i].length;
            bytes[] memory inner = new bytes[](m);
            for (uint256 j = 0; j < m; ++j) {
                inner[j] = groups[i][j].item;
            }
            out[i] = inner;
        }
    }
}
