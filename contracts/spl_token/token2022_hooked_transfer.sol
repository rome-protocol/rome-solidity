// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICrossProgramInvocation, CpiProgram} from "../interface.sol";
import {SolanaConstants} from "../cpi/SolanaConstants.sol";
import {Convert} from "../convert.sol";

/// @title Token2022HookedTransfer
/// @notice Builds and executes Token-2022 TransferChecked with a caller-resolved
///         Transfer Hook account plan.
/// @dev Token-2022, not this library, executes and enforces the hook. The
///      account tail must be resolved from the mint's ExtraAccountMetaList by
///      the integrating client/adapter. This path is direct CPI only.
library Token2022HookedTransfer {
    uint8 internal constant TRANSFER_CHECKED = 12;

    error CpiFailed(bytes reason);
    error IncompleteHookAccountPlan(uint256 actual);
    error InvalidHookProgramMeta(bytes32 expected, bytes32 actual, bool signer, bool writable);
    error InvalidValidationMeta(bytes32 expected, bytes32 actual, bool signer, bool writable);

    /// @notice Validate the invariant trailer Token-2022 appends after the four
    ///         fixed TransferChecked accounts and all accounts resolved from
    ///         ExtraAccountMetaList: hook program, then validation PDA.
    function validate(
        bytes32 expectedHookProgram,
        bytes32 expectedValidation,
        ICrossProgramInvocation.AccountMeta[] calldata hookMetas
    ) internal pure {
        if (hookMetas.length < 2) {
            revert IncompleteHookAccountPlan(hookMetas.length);
        }

        uint256 hookIndex = hookMetas.length - 2;
        ICrossProgramInvocation.AccountMeta calldata hook = hookMetas[hookIndex];
        if (
            hook.pubkey != expectedHookProgram ||
            hook.is_signer ||
            hook.is_writable
        ) {
            revert InvalidHookProgramMeta(
                expectedHookProgram, hook.pubkey, hook.is_signer, hook.is_writable
            );
        }

        ICrossProgramInvocation.AccountMeta calldata validation =
            hookMetas[hookIndex + 1];
        if (
            validation.pubkey != expectedValidation ||
            validation.is_signer ||
            validation.is_writable
        ) {
            revert InvalidValidationMeta(
                expectedValidation,
                validation.pubkey,
                validation.is_signer,
                validation.is_writable
            );
        }
    }

    function plan(
        bytes32 source,
        bytes32 mint,
        bytes32 destination,
        bytes32 authority,
        uint64 amount,
        uint8 decimals,
        ICrossProgramInvocation.AccountMeta[] calldata hookMetas
    )
        internal
        pure
        returns (
            bytes memory data,
            ICrossProgramInvocation.AccountMeta[] memory metas
        )
    {
        data = transferCheckedData(amount, decimals);
        metas = new ICrossProgramInvocation.AccountMeta[](4 + hookMetas.length);
        metas[0] = ICrossProgramInvocation.AccountMeta(source, false, true);
        metas[1] = ICrossProgramInvocation.AccountMeta(mint, false, false);
        metas[2] = ICrossProgramInvocation.AccountMeta(destination, false, true);
        metas[3] = ICrossProgramInvocation.AccountMeta(authority, true, false);
        for (uint256 i; i < hookMetas.length; ++i) {
            metas[4 + i] = hookMetas[i];
        }
    }

    /// @dev Delegatecall is required: the Rome CPI precompile signs as the EVM
    ///      caller visible in the current context. CALL would make the wrapper
    ///      contract, rather than the user/delegate, the Solana authority.
    function transferChecked(
        bytes32 source,
        bytes32 mint,
        bytes32 destination,
        bytes32 authority,
        uint64 amount,
        uint8 decimals,
        ICrossProgramInvocation.AccountMeta[] calldata hookMetas
    ) internal {
        (bytes memory data, ICrossProgramInvocation.AccountMeta[] memory metas) =
            plan(source, mint, destination, authority, amount, decimals, hookMetas);
        (bool ok, bytes memory result) = address(CpiProgram).delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                SolanaConstants.TOKEN_2022_PROGRAM,
                metas,
                data
            )
        );
        if (!ok) revert CpiFailed(result);
    }

    function transferCheckedData(uint64 amount, uint8 decimals)
        internal
        pure
        returns (bytes memory data)
    {
        data = abi.encodePacked(
            bytes1(TRANSFER_CHECKED), Convert.u64le(amount), bytes1(decimals)
        );
    }
}
