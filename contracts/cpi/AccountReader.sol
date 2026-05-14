// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CpiProgram} from "../interface.sol";

/// @title AccountReader
/// @notice Typed wrappers over the `CpiProgram` precompile's account-read
///         selectors (`account_lamports`, `account_u64_at`, `account_data_at`).
/// @dev
///   Solana account data lives in raw byte buffers parsed at known offsets.
///   Adapter authors who read Mint / TokenAccount / Anchor account layouts
///   reach for the same three precompile shortcuts repeatedly:
///
///   - `account_lamports(pubkey) → uint64`              — `0xde79ed54`
///   - `account_u64_at(pubkey, offset) → uint64`        — `0xb317d4c1`
///   - `account_data_at(pubkey, offset, length) → bytes`— `0x593762e8`
///
///   `AccountReader` exposes these under names that read as intent rather
///   than mechanism, plus a `readBytes32At` convenience that parses a
///   32-byte slice without the caller having to slice + decode by hand.
///
///   Selector hex was verified via `cast keccak` against rome-evm-private
///   const definitions on 2026-05-13 and tracked in `rome-evm-private/
///   CLAUDE.md` §"Non-EVM Bridge".
///
/// ## Scope (deliberately thin)
///
///   This library only contains typed-read primitives. Per the audit
///   red-team (2026-05-14): invariant helpers like `expectDiscriminator`,
///   `expectOwner`, `expectDataLen` are NOT included — no current consumer
///   needs them. Add them when a consumer does, not before.
///
/// ## Live behavior
///
///   Every function dispatches through the `CpiProgram` pre-bound constant
///   (precompile at `0xff00…0008`). The precompile signs the read as the
///   EVM caller via Rome's `external_auth` derivation; for read-only
///   account inspection this is irrelevant but worth knowing when reading
///   the source.
library AccountReader {
    /// Lamports balance of `account`. Cheapest read — no data buffer
    /// fetch. Common pattern: gate-check whether an account exists at all
    /// (lamports == 0 ↔ account uninitialized) before issuing a heavier
    /// `readU64At` or `readBytesAt`.
    function lamportsOf(bytes32 account) internal view returns (uint64) {
        return CpiProgram.account_lamports(account);
    }

    /// Read a little-endian `uint64` at `offset` bytes into `account`'s
    /// data buffer. The most common SPL Token offset (e.g. Mint.supply
    /// at offset 36, TokenAccount.amount at offset 64, TokenAccount.
    /// delegated_amount at offset 121).
    function readU64At(bytes32 account, uint16 offset) internal view returns (uint64) {
        return CpiProgram.account_u64_at(account, offset);
    }

    /// Read `length` bytes starting at `offset` from `account`'s data
    /// buffer. Returns the raw slice. Caller parses (Borsh, COption,
    /// custom layout).
    function readBytesAt(bytes32 account, uint16 offset, uint16 length)
        internal
        view
        returns (bytes memory)
    {
        return CpiProgram.account_data_at(account, offset, length);
    }

    /// Convenience: read a 32-byte slice at `offset` and return it as
    /// `bytes32`. Common SPL Token offsets: Mint.mint_authority option
    /// (offset 0-4 = discriminator + 4-36 = pubkey), TokenAccount.mint
    /// (offset 0), TokenAccount.owner (offset 32), TokenAccount.delegate
    /// option (offset 72-108).
    function readBytes32At(bytes32 account, uint16 offset) internal view returns (bytes32) {
        bytes memory slice = CpiProgram.account_data_at(account, offset, 32);
        bytes32 out;
        assembly {
            out := mload(add(slice, 32))
        }
        return out;
    }
}
