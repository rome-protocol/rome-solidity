// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HelperProgram} from "../interface.sol";

/// @title EnsureAta
/// @notice Idempotently ensure a user's Associated Token Account exists for
///         a given SPL mint, before an EVM contract dispatches a Solana CPI
///         that requires the ATA to be initialized.
///
/// ## Why
///
/// Many Solana programs (Anchor-built ones in particular) declare token
/// accounts with `Account<'info, TokenAccount>` constraints. Anchor's
/// account-validation pass runs BEFORE the handler body and rejects with
/// `Custom(3012) AccountNotInitialized` if the buffer is empty. Meteora's
/// DAMM v1 swap, every standard SPL transfer routed through PDA-owned
/// ATAs, Compound supply/borrow flows that touch wrapped tokens — all
/// pre-check ATA existence and revert before the EVM-side caller can
/// recover.
///
/// EVM-side routers that compose such CPIs should call `EnsureAta.ensure`
/// for each ATA they expect to touch. The ATA gets created lazily, in the
/// same outer Rome DoTx, before the downstream CPI runs — so the user
/// sees one transaction, atomic, no failed mid-flight setup.
///
/// ## Idempotency
///
/// `HelperProgram.create_ata(address, bytes32)` dispatches Solana's
/// `create_associated_token_account_idempotent` instruction. The
/// idempotent variant is a runtime no-op when the ATA already exists.
/// We therefore skip the explicit `account_lamports` probe — the gap
/// between "probe-and-skip" and "idempotent no-op CPI" is small (~50K CU
/// vs ~5K CU), and the single-selector design keeps consumers tight
/// and easier to audit.
///
/// Source-of-idempotency: the Rome EVM program's `create_ata_internal`
/// (see helper.rs) issues `spl_associated_token_account::instruction::
/// create_associated_token_account_idempotent`.
///
/// ## CU envelope
///
/// - ATA exists: ~50K Solana CU (idempotent no-op syscall path)
/// - ATA missing: ~110K Solana CU (creates the ATA on-chain)
///
/// Two `ensure` calls (typical swap: in-token + out-token) = 100-220K CU.
/// Comfortable within the 1.4M atomic-tx envelope.
///
/// ## Precondition
///
/// User MUST be activated (`SimpleActivator.isActivated(user) == true`).
/// `create_ata` signs as `external_auth(user)` which only exists once the
/// user's PDA is funded. Routers should gate at a higher layer; this
/// library does not re-check activation.
library EnsureAta {
    /// @notice Idempotent ATA-create for `mint` owned by `user`.
    /// @dev Reverts if the underlying HelperProgram CPI fails (e.g. PDA
    ///      not funded). Reads the precompile via delegatecall so
    ///      `msg.sender` in the helper's frame is the caller of this
    ///      library function — the helper signs as `external_auth(caller)`
    ///      which must match the `user` arg semantically.
    function ensure(address user, bytes32 mint) internal {
        (bool ok, bytes memory ret) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("create_ata(address,bytes32)", user, mint)
        );
        if (!ok) {
            if (ret.length < 68) revert("EnsureAta: CREATE_FAILED");
            assembly { ret := add(ret, 0x04) }
            revert(abi.decode(ret, (string)));
        }
    }
}
