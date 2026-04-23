// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISystemProgram, SystemProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {AssociatedSplToken} from "../spl_token/associated_spl_token.sol";
import {SolanaConstants} from "./SolanaConstants.sol";

/// @title UserPda
/// @notice EVM address → Solana user PDA + ATA lookup.
/// @dev
///   Single entry point for EVM → Solana user identity. **Takes an explicit
///   `address user` argument — no overload reads `tx.origin`.** This closes
///   the `tx.origin` phishing hole described in cardo-foundation.md §9.
///
///   Adapters always call `UserPda.pda(msg.sender)` (or for adapters that
///   legitimately take a user arg, e.g. Meteora's `to`, after authenticating
///   it). A future PR that introduces a tx.origin overload fails both the
///   CI grep and the signature-matches-interface test in
///   `tests/cpi/UserPda.test.ts`.
library UserPda {
    /// User's Rome EVM PDA. Wraps `RomeEVMAccount.pda`.
    function pda(address user) internal view returns (bytes32) {
        return RomeEVMAccount.pda(user);
    }

    /// User's Associated Token Account for the given mint, assuming the
    /// classic SPL Token program (Tokenkeg...). Token-2022 ATAs use a
    /// different derivation; adapters that support Token-2022 call
    /// `ataWithProgram` directly.
    function ata(address user, bytes32 mint) internal view returns (bytes32) {
        bytes32 owner = pda(user);
        return AssociatedSplToken.get_associated_token_address_with_program_id(
            owner,
            mint,
            SolanaConstants.SPL_TOKEN_PROGRAM,
            SolanaConstants.ASSOCIATED_TOKEN_PROGRAM
        );
    }

    /// Derive an ATA for a raw Solana pubkey (pool-side, fee receiver, etc.).
    /// Used when the "wallet" isn't a Rome EVM user — e.g. Meteora pool's
    /// protocol token fee accumulator.
    function ataForKey(bytes32 ownerKey, bytes32 mint)
        internal
        pure
        returns (bytes32)
    {
        return AssociatedSplToken.get_associated_token_address_with_program_id(
            ownerKey,
            mint,
            SolanaConstants.SPL_TOKEN_PROGRAM,
            SolanaConstants.ASSOCIATED_TOKEN_PROGRAM
        );
    }

    /// ATA with caller-supplied token program. Reserved for future Token-2022
    /// support — no current adapter uses it. Kept internal so Slither won't
    /// flag as unused; tests can exercise via the wrapper.
    function ataWithProgram(address user, bytes32 mint, bytes32 tokenProgram)
        internal
        view
        returns (bytes32)
    {
        bytes32 owner = pda(user);
        return AssociatedSplToken.get_associated_token_address_with_program_id(
            owner,
            mint,
            tokenProgram,
            SolanaConstants.ASSOCIATED_TOKEN_PROGRAM
        );
    }
}
