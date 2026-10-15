// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    ICrossProgramInvocation,
    CpiProgram,
    cpi_program_address
} from "../interface.sol";

/// @title Cpi
/// @notice Canonical wrapper around the Rome EVM CPI precompile.
/// @dev
///   Single call site for every Cross-Program Invocation from Rome EVM to a
///   Solana program. Replaces the 12 inline
///   `ICrossProgramInvocation(CPI_PRECOMPILE).invoke(...)` occurrences across
///   Meteora / Kamino / Drift.
///
///   Adapters:
///     Cpi.invoke(program, metas, data);
///     Cpi.invokeSigned(program, metas, data, seeds);
///     (uint64 lam, bytes32 owner, , , , bytes memory acctData)
///         = Cpi.accountInfo(pubkey);
///
///   Who signs: the contract that calls the precompile signs as itself, never
///   as the user. Its signer is its own authority PDA,
///   `HelperProgram.pda(address(this))`. A contract cannot sign for a user's
///   authority, and cannot spend a user's token account unless the user first
///   grants it an SPL delegation (`approve_spl`).
///
///   `Cpi.invoke` adds the calling contract's authority as a signer when that
///   account is listed in the account metas with `is_signer = true`. It takes
///   no salts, so that is its only signer path.
///
///   `Cpi.invokeSigned` takes a `bytes32[] memory seeds` payload of salts.
///   Each salt derives a sub-PDA of the calling contract's authority, and each
///   one must be listed in the account metas as a signer. Use it when the
///   target instruction needs a salted sub-PDA as a signer (e.g. a per-user
///   owner account, or a payer PDA for pool-creation rent). It can still sign
///   with the bare authority too.
///
///   If the precompile itself is reached by `DELEGATECALL` or `CALLCODE`
///   (for example `address(PRECOMPILE).delegatecall(...)`), it refuses the
///   bare authority (`DelegatecallOwnerAuthority`) and namespaces salted
///   sub-PDAs by the running contract's address. The functions here make a
///   normal `CALL`, so code running under a delegatecall still signs as
///   `address(this)`. Never delegatecall the precompile.
library Cpi {
    /// CPI precompile address — lives at 0xFF00000000000000000000000000000000000008.
    /// Constant kept here (as well as in interface.sol) so adapters don't need
    /// two imports to reach the precompile.
    address internal constant PRECOMPILE = cpi_program_address;

    /// Invoke a Solana program through the CPI precompile. The calling
    /// contract signs as itself: list `HelperProgram.pda(address(this))` as a
    /// signer in `metas` to have its authority sign.
    /// @dev The Solana runtime limits how deeply CPIs can nest, and a CPI made
    ///      here runs inside the Rome EVM program's own frame, so keep call
    ///      chains shallow. Each CPI also spends compute units from the
    ///      transaction's budget; adapters that chain several should budget
    ///      for that.
    function invoke(
        bytes32 program,
        ICrossProgramInvocation.AccountMeta[] memory metas,
        bytes memory data
    ) internal {
        CpiProgram.invoke(program, metas, data);
    }

    /// Invoke a Solana program with caller-supplied salts (signed CPI). Each
    /// salt derives a sub-PDA of the calling contract's authority, and every
    /// such sub-PDA must be listed in `metas` as a signer, or the call fails
    /// with `signer account calculated from the provided seed was not found`.
    /// @dev The same depth and compute-unit notes apply as for `invoke`.
    function invokeSigned(
        bytes32 program,
        ICrossProgramInvocation.AccountMeta[] memory metas,
        bytes memory data,
        bytes32[] memory seeds
    ) internal {
        CpiProgram.invoke_signed(program, metas, data, seeds);
    }

    /// Read the 6-tuple from the precompile's `account_info`:
    ///   lamports, owner, is_signer, is_writable, executable, data
    /// @dev IMPORTANT: `pubkey` must be present in the outer Solana transaction's
    ///      account list. Rome's precompile handler resolves `pubkey` against the
    ///      `AccountInfo[]` passed to the Rome EVM program entrypoint — pubkeys
    ///      the Solana client did not pre-list are not fetched on demand. A
    ///      missing pubkey reverts with an error indistinguishable from "account
    ///      does not exist on chain." When probing arbitrary pubkeys (e.g.,
    ///      oracle-feed accounts not directly listed in the capability's account
    ///      set), the caller is responsible for including them in the tx account
    ///      list via the rome-sdk or rome-evm-client tx builder. Executable
    ///      accounts additionally return empty `data` — `lamports` and `owner`
    ///      are still canonical.
    function accountInfo(bytes32 pubkey)
        internal
        view
        returns (
            uint64 lamports,
            bytes32 owner,
            bool isSigner,
            bool isWritable,
            bool executable,
            bytes memory data
        )
    {
        (lamports, owner, isSigner, isWritable, executable, data) =
            CpiProgram.account_info(pubkey);
    }
}
