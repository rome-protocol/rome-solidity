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
///   `Cpi.invokeSigned` passes a `bytes32[] memory seeds` payload to the
///   precompile so the CPI is signed by the EVM caller's Rome-EVM PDA. Used
///   when the Solana program expects the Rome PDA as a signer — e.g. any
///   instruction that moves tokens out of the user's ATA.
///
///   `Cpi.invoke` skips the signed-seeds path — the precompile derives the
///   signer automatically from the caller's Rome PDA. Rule of thumb: use
///   `invoke` for the common case; reach for `invokeSigned` only when the
///   target instruction requires an explicit salt-derived signer (e.g.
///   Meteora's payer PDA for pool-creation rent).
library Cpi {
    /// CPI precompile address — lives at 0xFF00000000000000000000000000000000000008.
    /// Constant kept here (as well as in interface.sol) so adapters don't need
    /// two imports to reach the precompile.
    address internal constant PRECOMPILE = cpi_program_address;

    /// Invoke a Solana program with the CPI precompile as the signer path.
    /// @dev Solana runtime enforces MAX_INSTRUCTION_STACK_HEIGHT = 5 — i.e. the
    ///      top-level tx plus up to 4 nested CPIs. Rome's EVM-in-Solana wrapper
    ///      consumes one frame before Solidity executes, so adapters have at
    ///      most 3 further nested CPIs before hitting the runtime cap (verify
    ///      against rome-evm-private precompile semantics).
    ///      SIMD-0268 (accepted, not yet activated) raises the limit to
    ///      stack-9 (8 nested CPIs); code calling `invoke` should not
    ///      special-case the pre-activation bound.
    /// @dev CU cost model: ~1000 CU per invoke/invokeSigned call plus
    ///      ~1 CU per 250 bytes of instruction data. `invokeSigned` is NOT
    ///      more expensive than `invoke` (invoke wraps invoke_signed with
    ///      empty seeds). Adapters chaining multiple CPIs under the
    ///      1,400,000 CU transaction ceiling should budget accordingly.
    function invoke(
        bytes32 program,
        ICrossProgramInvocation.AccountMeta[] memory metas,
        bytes memory data
    ) internal {
        CpiProgram.invoke(program, metas, data);
    }

    /// Invoke a Solana program with caller-supplied signer seeds (signed CPI).
    /// @dev Shares the same stack-height model as `invoke` — see the `invoke`
    ///      NatSpec for MAX_INSTRUCTION_STACK_HEIGHT = 5 and the SIMD-0268
    ///      forward-compat note.
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
