// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISystemProgram, SystemProgram, ICrossProgramInvocation, CpiProgram, HelperProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {AssociatedSplToken} from "../spl_token/associated_spl_token.sol";
import {SolanaConstants} from "./SolanaConstants.sol";
import {PdaDeriver} from "./PdaDeriver.sol";
import {PdasBatch} from "./PdasBatch.sol";

/// @title UserPda
/// @notice EVM address → Solana user PDA + ATA lookup.
/// @dev
///   Single entry point for EVM → Solana user identity. **Takes an explicit
///   `address user` argument — no overload reads `tx.origin`.**
///   This closes the `tx.origin` phishing hole: a contract that acts on
///   `tx.origin` can be driven by any contract the user calls.
///
///   Adapters call `UserPda.pda(msg.sender)` (or, for adapters that
///   legitimately take a user arg, e.g. Meteora's `to`, after authenticating
///   it) to name the user's accounts: to key a position, derive the ATA to
///   pay out to, or read balances. The user's authority is never a signer in
///   a contract's CPI; the contract signs as itself (see `Cpi`). A future PR
///   that introduces a tx.origin overload fails both the CI grep and the
///   signature-matches-interface test in `tests/cpi/UserPda.test.ts`.
library UserPda {
    /// User's Rome EVM PDA. Wraps `RomeEVMAccount.pda`.
    function pda(address user) internal view returns (bytes32) {
        return RomeEVMAccount.pda(user);
    }

    /// User's Associated Token Account for the given mint. The token program is
    /// resolved from the mint's own owner inside `HelperProgram.ata`, so this is
    /// correct for Token-2022 as well. An earlier revision of this comment said
    /// the opposite and sent readers to `ataWithProgram`; that is not needed
    /// here, and "fixing" this path would break it.
    ///
    /// Delegates to `HelperProgram.ata(address, bytes32)`, a single call to the
    /// HelperProgram precompile at `0xFF…09`. It returns the same address as
    /// deriving the owner PDA and then the ATA in two separate precompile
    /// calls, and costs fewer Solana CU than that two-hop path.
    function ata(address user, bytes32 mint) internal view returns (bytes32) {
        return HelperProgram.ata(user, mint);
    }

    /// Derive an ATA for a raw Solana pubkey (pool-side, fee receiver, etc.).
    /// Used when the "wallet" isn't a Rome EVM user — e.g. Meteora pool's
    /// protocol token fee accumulator.

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

    /// @notice ATA for a raw Solana pubkey owner (not an EVM address), with the
    ///         token program resolved from the mint's own owner — so this is
    ///         correct for legacy SPL Token and Token-2022 alike.
    ///
    /// @dev The program is part of the ATA seeds, so assuming one derives an
    ///      address that `create_ata_for_key` never creates. Resolving here
    ///      rather than asking callers to pass a program keeps that impossible
    ///      to get wrong, and mirrors `ata(address,bytes32)`, which resolves the
    ///      same way inside HelperProgram.
    ///
    ///      Reads via HelperProgram, so a cached-track contract must not call
    ///      this after staging a cached invoke — `verify_call` refuses a legacy
    ///      cross-state read at that point. No cached-track caller exists today.
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

    /// @dev Legacy SPL Token only — unlike `ataForKey`, this bakes in
    ///      SPL_TOKEN_PROGRAM. It has no caller outside its test wrapper, so it
    ///      is left as-is rather than given a per-mint resolve it would pay for
    ///      N times; it gains one when a consumer needs it.
    function atas(address user, bytes32[] memory mints)
        internal
        view
        returns (bytes32[] memory result)
    {
        uint256 n = mints.length;
        result = new bytes32[](n);
        if (n == 0) return result;

        bytes32 owner = pda(user);

        // Each ATA = find_program_address(
        //   [owner_pda, SPL_TOKEN_PROGRAM, mint_i],
        //   ASSOCIATED_TOKEN_PROGRAM
        // )
        ISystemProgram.Seed[][] memory groups = new ISystemProgram.Seed[][](n);
        for (uint256 i = 0; i < n; ++i) {
            groups[i] = PdaDeriver.makeSeeds(
                PdaDeriver.seedBytes(owner),
                PdaDeriver.seedBytes(SolanaConstants.SPL_TOKEN_PROGRAM),
                PdaDeriver.seedBytes(mints[i])
            );
        }

        ICrossProgramInvocation.PdaWithBump[] memory pdas =
            PdasBatch.derive(groups, SolanaConstants.ASSOCIATED_TOKEN_PROGRAM);
        for (uint256 i = 0; i < n; ++i) {
            result[i] = pdas[i].pda;
        }
    }
}
