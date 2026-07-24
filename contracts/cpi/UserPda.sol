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
    ///
    /// Delegates to `HelperProgram.ata(address, bytes32)` — selector
    /// `0xfeb1c647` on `0xff…09` (HelperProgram precompile; rome-evm-
    /// private #348/#349, post-2026-05-12 consolidation). The earlier
    /// `derive_user_ata` shortcut at `0xc654e119` on `0xff…08` (#319)
    /// was migrated to HelperProgram and no longer dispatches there.
    /// Behavior is byte-identical to the prior two-hop path through
    /// `0xFF…07` — verified on-chain against Marcus 121301 on 2026-05-
    /// 11 with EVM address `0xC777…2DAc` and USDC mint `4zMMC9sr…ncDU`
    /// (resulting ATA `FkFYez2a…n8vw`).
    ///
    /// Saves ~152K Solana CU per call vs the two-hop path (3-sample
    /// average on Marcus 121301: 281K → 129K, 54 % reduction).
    function ata(address user, bytes32 mint) internal view returns (bytes32) {
        return HelperProgram.ata(user, mint);
    }

    /// Derive an ATA for a raw Solana pubkey (pool-side, fee receiver, etc.).
    /// Used when the "wallet" isn't a Rome EVM user — e.g. Meteora pool's
    /// protocol token fee accumulator.
    ///
    /// LEGACY-ONLY: the classic SPL Token program is hardcoded in the seeds,
    /// so a Token-2022 mint derives a WRONG address here. Whenever the mint
    /// may be Token-2022, use `ataForKeyProgramAware` instead.
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

    /// Program-aware ATA derive for a raw Solana pubkey owner: delegates to
    /// `HelperProgram.ata_for_key` (0x9c755807), which reads the mint
    /// account's owner and derives under that token program — byte-identical
    /// to `ataForKey` for legacy mints, correct for Token-2022. Requires the
    /// mint account to exist (the EthCall fails loud on a missing mint).
    function ataForKeyProgramAware(bytes32 ownerKey, bytes32 mint)
        internal
        view
        returns (bytes32)
    {
        return HelperProgram.ata_for_key(ownerKey, mint);
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

    /// Batch-derive N ATAs for one EVM user across N classic SPL Token mints.
    ///
    /// Composes two primitives:
    ///   1. `RomeEVMAccount.pda(user)` — single dispatch, returns AUTHORITY_PDA
    ///   2. `PdasBatch.derive(seedGroups, ASSOCIATED_TOKEN_PROGRAM)` — N PDAs
    ///      in one syscall, each `[authority_pda, SPL_TOKEN_PROGRAM, mint_i]`
    ///
    /// CU vs N×`ata(user, mint)`: the per-mint `HelperProgram.ata` shortcut
    /// is ~129K CU each (Hadrian 2026-05-14 baseline). This path is one
    /// `find_program_address` for the AUTHORITY_PDA plus one
    /// `pdas_batch_derive` for the N ATAs — pays off at N ≥ 2 mints, with the
    /// per-PDA saving growing with N. Measurement post-deploy lands in
    /// `the Rome design specs`.
    ///
    /// Use this when one user owns ATAs across multiple mints (Compound
    /// bulker supply/borrow lists, multi-token swap UIs probing balances,
    /// portfolio screens enumerating per-mint balances). For single-mint or
    /// arbitrary-owner cases, prefer `ata(user, mint)` / `ataForKey(...)`.
    ///
    /// LEGACY-ONLY: every seed group hardcodes the classic SPL Token
    /// program; a Token-2022 mint in the list derives a WRONG address.
    /// Deliberately unchanged — making this variant read N mint owners would
    /// add N account reads + N accounts to existing legacy adapter flows
    /// near the 28-key ALT threshold. Token-2022 adapters use
    /// `atasWithPrograms` and pass the programs they already know.
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

    /// Program-aware batch derive: like `atas`, but each seed group takes
    /// the CALLER-SUPPLIED token program for that mint — zero extra account
    /// reads, so it costs the same as `atas`. Adapters registering
    /// Token-2022 wrappers already know each mint's program (from the
    /// factory tier record or `wrap_allowed`); passing it here keeps
    /// existing legacy flows and their ALT budgets untouched.
    function atasWithPrograms(
        address user,
        bytes32[] memory mints,
        bytes32[] memory tokenPrograms
    )
        internal
        view
        returns (bytes32[] memory result)
    {
        uint256 n = mints.length;
        require(tokenPrograms.length == n, "UserPda: programs length mismatch");
        result = new bytes32[](n);
        if (n == 0) return result;

        bytes32 owner = pda(user);

        ISystemProgram.Seed[][] memory groups = new ISystemProgram.Seed[][](n);
        for (uint256 i = 0; i < n; ++i) {
            groups[i] = PdaDeriver.makeSeeds(
                PdaDeriver.seedBytes(owner),
                PdaDeriver.seedBytes(tokenPrograms[i]),
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
