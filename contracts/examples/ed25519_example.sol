// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";

/// Worked example: verifying a single ed25519 signature via the IEd25519 precompile.
///
/// The caller provides:
///   - `allowed_signers`: bytes32[] of trusted ed25519 public keys
///   - `expected_message`: bytes the caller asserts the runtime verified
///   - `ed25519_ix_idx`: top-level Solana ix index of the Ed25519SigVerify ix
///   - `sig_idx`: which signature within that ix (multi-sig batching support)
///
/// On success, returns the verified signer pubkey (∈ allowed_signers).
/// Reverts otherwise. See rome-evm-private's `non_evm/ed25519_ix.rs` for the
/// 15 error variants and what triggers each.
///
/// Real consumers (e.g. the Pyth Lazer wrapper) inline this pattern but pin
/// `allowed_signers` to a hardcoded allowlist (e.g. just the Lazer signer
/// pubkey) and supply the on-wire envelope as `expected_message`.
contract ed25519_example {
    function verify_one(
        bytes32[] calldata allowed_signers,
        bytes calldata expected_message,
        uint8 ed25519_ix_idx,
        uint8 sig_idx
    ) external view returns (bytes32 verified_signer) {
        return Ed25519.verify_from_allowlist(
            allowed_signers,
            expected_message,
            ed25519_ix_idx,
            sig_idx
        );
    }
}
