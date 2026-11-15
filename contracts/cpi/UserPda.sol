// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HelperProgram} from "../interface.sol";
import {AssociatedSplToken} from "../spl_token/associated_spl_token.sol";
import {SolanaConstants} from "./SolanaConstants.sol";

/// @title UserPda
/// @dev Solana ATA derivation; takes explicit arguments and never reads `tx.origin`.
library UserPda {
    /// @notice ATA of a raw Solana owner key; the token program is resolved from the mint's own owner.
    /// @dev Reads via HelperProgram, so a cached-track contract must not call this after staging a cached invoke.
    function ataForKey(bytes32 ownerKey, bytes32 mint)
        internal
        view
        returns (bytes32)
    {
        (bytes32 tokenProgram, , , ,) = HelperProgram.mint_info(mint);
        return AssociatedSplToken.get_associated_token_address_with_program_id(
            ownerKey,
            mint,
            tokenProgram,
            SolanaConstants.ASSOCIATED_TOKEN_PROGRAM
        );
    }
}
