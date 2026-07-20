// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISystemProgram, ICrossProgramInvocation} from "../../interface.sol";
import {PdasBatch} from "../PdasBatch.sol";
import {PdaDeriver} from "../PdaDeriver.sol";

/// @dev Test-only wrapper exposing PdasBatch for Hardhat tests.
///      Note: the `derive` paths are `view` because they hit the CPI
///      precompile (`0xFF…08`) which doesn't exist on hardhatMainnet —
///      they're exercised end-to-end against live Rome EVM. This wrapper
///      proves the library compiles + lets non-precompile assertions
///      (unwrap shape, builder composition) run on the simulated chain.
contract PdasBatchWrapper {

    /// Roundtrip an empty input — verifies the empty path compiles.
    /// (The precompile short-circuits N=0 and returns an empty array.)
    function deriveEmpty(bytes32 programId)
        external
        view
        returns (uint256)
    {
        ISystemProgram.Seed[][] memory groups = new ISystemProgram.Seed[][](0);
        ICrossProgramInvocation.PdaWithBump[] memory pdas =
            PdasBatch.derive(groups, programId);
        return pdas.length;
    }

    /// Compose builders → derive(N=2). Returns the input shape only;
    /// the precompile call is short-circuited on hardhatMainnet so this
    /// return is reachable only on live Rome. The test asserts the
    /// `groups` shape before the call.
    function buildPair(bytes32 a, bytes32 b)
        external
        pure
        returns (uint256 groupCount, uint256 innerLenA, uint256 innerLenB)
    {
        string memory markerA = "MARKER_A";
        string memory markerB = "MARKER_B";
        ISystemProgram.Seed[][] memory groups = new ISystemProgram.Seed[][](2);
        groups[0] = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(a),
            PdaDeriver.seedBytes(markerA)
        );
        groups[1] = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(b),
            PdaDeriver.seedBytes(markerB)
        );
        groupCount = groups.length;
        innerLenA = groups[0].length;
        innerLenB = groups[1].length;
    }

    /// Live-precompile path: 2-PDA batch via `pair` convenience.
    function derivePair(
        bytes32 a,
        bytes32 b,
        bytes32 programId
    )
        external
        view
        returns (bytes32 keyA, bytes32 keyB, uint8 bumpA, uint8 bumpB)
    {
        string memory markerA = "MARKER_A";
        string memory markerB = "MARKER_B";
        ISystemProgram.Seed[] memory seedsA = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(a),
            PdaDeriver.seedBytes(markerA)
        );
        ISystemProgram.Seed[] memory seedsB = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(b),
            PdaDeriver.seedBytes(markerB)
        );
        (
            ICrossProgramInvocation.PdaWithBump memory rA,
            ICrossProgramInvocation.PdaWithBump memory rB
        ) = PdasBatch.pair(seedsA, seedsB, programId);
        keyA = rA.pda;
        keyB = rB.pda;
        bumpA = rA.bump;
        bumpB = rB.bump;
    }

    /// Live-precompile path: 5-PDA generic batch (a typical
    /// multi-PDA adapter group shape).
    function deriveFive(
        bytes32 pool,
        bytes32 token_a_mint,
        bytes32 token_b_mint,
        bytes32 a_vault,
        bytes32 b_vault,
        bytes32 dynamic_amm_program
    )
        external
        view
        returns (ICrossProgramInvocation.PdaWithBump[] memory)
    {
        string memory lpMintPrefix = "lp_mint";
        string memory protocolFeePrefix = "protocol_token_fee";

        ISystemProgram.Seed[][] memory groups = new ISystemProgram.Seed[][](5);

        // lp_mint = [LP_MINT_PREFIX, pool]
        groups[0] = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(lpMintPrefix),
            PdaDeriver.seedBytes(pool)
        );
        // a_vault_lp = [a_vault, pool]
        groups[1] = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(a_vault),
            PdaDeriver.seedBytes(pool)
        );
        // b_vault_lp = [b_vault, pool]
        groups[2] = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(b_vault),
            PdaDeriver.seedBytes(pool)
        );
        // protocol_token_a_fee = [PROTOCOL_FEE_PREFIX, token_a_mint, pool]
        groups[3] = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(protocolFeePrefix),
            PdaDeriver.seedBytes(token_a_mint),
            PdaDeriver.seedBytes(pool)
        );
        // protocol_token_b_fee = [PROTOCOL_FEE_PREFIX, token_b_mint, pool]
        groups[4] = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(protocolFeePrefix),
            PdaDeriver.seedBytes(token_b_mint),
            PdaDeriver.seedBytes(pool)
        );

        return PdasBatch.derive(groups, dynamic_amm_program);
    }
}
