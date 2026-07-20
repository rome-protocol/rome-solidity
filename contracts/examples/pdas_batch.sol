// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISystemProgram, ICrossProgramInvocation} from "../interface.sol";
import {PdaDeriver} from "../cpi/PdaDeriver.sol";
import {PdasBatch} from "../cpi/PdasBatch.sol";

/// @title pdas_batch_example
/// @notice Worked example for the `PdasBatch` library — multi-PDA
///         derivation on the CPI precompile (`0xFF…08`, selector
///         `0x944336f8`).
///
///         The example mirrors a common "five program PDAs in one
///         syscall" adapter shape.
///
///         Read this when you need to derive 2+ PDAs against the same
///         Solana program in one call. For 1 PDA, prefer `PdaDeriver`.
contract pdas_batch_example {

    /// Batch-derive the 5 dynamic_amm_program PDAs Meteora needs during
    /// permissionless-pool init. Returns the (pda, bump) pairs in the
    /// same order as the inputs.
    function derive_amm_phase(
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

        // 0: lp_mint                     = [LP_MINT_PREFIX, pool]
        groups[0] = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(lpMintPrefix),
            PdaDeriver.seedBytes(pool)
        );
        // 1: a_vault_lp                  = [a_vault, pool]
        groups[1] = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(a_vault),
            PdaDeriver.seedBytes(pool)
        );
        // 2: b_vault_lp                  = [b_vault, pool]
        groups[2] = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(b_vault),
            PdaDeriver.seedBytes(pool)
        );
        // 3: protocol_token_a_fee        = [PROTO_FEE_PREFIX, token_a_mint, pool]
        groups[3] = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(protocolFeePrefix),
            PdaDeriver.seedBytes(token_a_mint),
            PdaDeriver.seedBytes(pool)
        );
        // 4: protocol_token_b_fee        = [PROTO_FEE_PREFIX, token_b_mint, pool]
        groups[4] = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(protocolFeePrefix),
            PdaDeriver.seedBytes(token_b_mint),
            PdaDeriver.seedBytes(pool)
        );

        return PdasBatch.derive(groups, dynamic_amm_program);
    }

    /// Two-PDA example with the `pair` convenience overload.
    function derive_user_obligation_and_market(
        bytes32 user_pda,
        uint16 market_id,
        bytes32 adapter_program
    )
        external
        view
        returns (
            bytes32 obligation,
            uint8 obligationBump,
            bytes32 marketAccount,
            uint8 marketBump
        )
    {
        string memory obligationPrefix = "obligation";
        string memory marketPrefix = "market";

        ISystemProgram.Seed[] memory obligationSeeds = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(obligationPrefix),
            PdaDeriver.seedBytes(user_pda)
        );
        ISystemProgram.Seed[] memory marketSeeds = PdaDeriver.makeSeeds(
            PdaDeriver.seedBytes(marketPrefix),
            PdaDeriver.seedBytesU16Le(market_id)
        );

        (
            ICrossProgramInvocation.PdaWithBump memory ob,
            ICrossProgramInvocation.PdaWithBump memory mk
        ) = PdasBatch.pair(obligationSeeds, marketSeeds, adapter_program);

        obligation = ob.pda;
        obligationBump = ob.bump;
        marketAccount = mk.pda;
        marketBump = mk.bump;
    }
}
