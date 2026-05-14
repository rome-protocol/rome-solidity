// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISystemProgram, SystemProgram, ICrossProgramInvocation, CpiProgram} from "../../interface.sol";

/// @title PdaCostProbe
/// @notice Measurement contract for the `find_program_address` vs
///         `pdas_batch_derive` CU cost question — P3.1 in the rome-solidity
///         audit plan (2026-05-14).
///
/// @dev The goal is to answer whether `pdas_batch_derive(seed_groups, program_id)`
///      saves material Solana CU when batching N PDAs against the same
///      program, vs N separate `SystemProgram.find_program_address` calls.
///
///      The red team flagged that `find_program_address` is an `EthCall`
///      variant (not a true CPI) so the per-hop overhead is dominated by
///      EVM-side ABI marshaling + atomic-tx wrapper overhead. The CLAUDE.md
///      cites ~115K CU per hop end-to-end. If batching reduces marshaling /
///      wrapper overhead, savings should be material. Measurement confirms.
///
///      Three probes mirror the shapes adapters actually use:
///      - `probeOnePda` — single derivation (baseline per-hop)
///      - `probeSevenIndividual` — 7 separate find_program_address (Meteora
///        DAMM_AMM cluster shape)
///      - `probeSevenBatched` — same 7 PDAs via pdas_batch_derive (one
///        dispatch against one program_id)
///
///      The seeds match the actual shape Meteora uses (`b"pool" + token_a +
///      token_b + index`) so the probe is representative, not a microbench.
///
///      Run via `scripts/cpi/measure-pda-cost.ts` against a live Rome chain
///      (Marcus or any chain with the new pdas_batch_derive selector).
contract PdaCostProbe {
    /// Same Meteora-style seed shape, parametrized by a salt that callers
    /// vary to force unique PDAs (so the runtime can't cache the result
    /// across calls).
    function _seedsFor(uint256 idx) internal pure returns (ISystemProgram.Seed[] memory) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(bytes("pool"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(uint256(0xa1), idx));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(uint256(0xb2), idx));
        return seeds;
    }

    /// Baseline: 1 find_program_address dispatch via System precompile.
    /// Returns the PDA to defeat dead-code elimination.
    function probeOnePda(uint256 idx) external view returns (bytes32) {
        bytes32 programId = SystemProgram.rome_evm_program_id();
        (bytes32 pda, ) = SystemProgram.find_program_address(programId, _seedsFor(idx));
        return pda;
    }

    /// Meteora-shaped: 7 sequential find_program_address dispatches against
    /// the same program_id. Returns all 7 to defeat dead-code elimination.
    function probeSevenIndividual(uint256 baseIdx) external view returns (bytes32[] memory) {
        bytes32 programId = SystemProgram.rome_evm_program_id();
        bytes32[] memory pdas = new bytes32[](7);
        for (uint256 i = 0; i < 7; i++) {
            (bytes32 pda, ) = SystemProgram.find_program_address(programId, _seedsFor(baseIdx + i));
            pdas[i] = pda;
        }
        return pdas;
    }

    /// Same 7 PDAs via pdas_batch_derive — one dispatch against one
    /// program_id. The batch selector encodes each seed group as
    /// `bytes[]` then groups them as `bytes[][]`.
    function probeSevenBatched(uint256 baseIdx) external view returns (ICrossProgramInvocation.PdaWithBump[] memory) {
        bytes32 programId = SystemProgram.rome_evm_program_id();
        bytes[][] memory seedGroups = new bytes[][](7);
        for (uint256 i = 0; i < 7; i++) {
            seedGroups[i] = new bytes[](3);
            seedGroups[i][0] = bytes("pool");
            seedGroups[i][1] = abi.encodePacked(uint256(0xa1), baseIdx + i);
            seedGroups[i][2] = abi.encodePacked(uint256(0xb2), baseIdx + i);
        }
        return CpiProgram.pdas_batch_derive(seedGroups, programId);
    }
}
