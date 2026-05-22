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
/// ## Live behavior — these are reads, not CPIs
///
///   Every function dispatches through the `CpiProgram` pre-bound constant
///   (precompile at `0xff00…0008`). The name "CpiProgram" is historical:
///   the precompile carries both arbitrary Solana CPI dispatch (`invoke` /
///   `invoke_signed`, selectors `0x7480cb86` / `0xb94f3733`) AND a family
///   of read-side shortcut selectors. The three selectors used here —
///   `account_data_at` (`0x593762e8`), `account_u64_at` (`0xb317d4c1`),
///   `account_lamports` (`0xde79ed54`) — dispatch as
///   `NonEvmCall::CrossStateEthCall`, not `NonEvmCall::Invoke`.
///
///   Concretely, this means:
///
///   - **No Solana CPI is issued.** The on-chain dispatcher routes these
///     selectors through `cross_state_call`, which reads the target
///     `AccountInfo` and returns the bytes. There is no inner Solana
///     program invocation.
///   - **No signing.** No `invoke_signed`, no PDA seeds, no
///     `external_auth(caller)` derivation participates in the read.
///     `AccountReader` never calls a signed path; the signing semantics
///     of `invoke_signed` apply only to the two `Invoke` selectors and
///     are not on the code path of any function in this library.
///   - **No on-chain side effect.** These are pure cross-state queries —
///     equivalent to an `eth_call` against a Solana account.
///
///   Source of truth for the dispatch routing: `rome-evm-private/program/
///   src/non_evm/cpi.rs:65` (the `ACCOUNT_DATA_AT => CrossStateEthCall`
///   match arm; the three v2 selectors `ACCOUNT_U64_AT`, `ACCOUNT_LAMPORTS`,
///   `PDAS_BATCH_DERIVE` join the same arm on lines 71-73). The full per-
///   selector dispatch table is in
///   [`rome-evm-private/CLAUDE.md`](../../../rome-evm-private/CLAUDE.md) §
///   "CpiProgram" — column "Dispatch" labels each selector with its
///   `NonEvmCall` variant.
///
///   The signing path (`invoke_signed` → `EXTERNAL_AUTHORITY(caller)` PDA)
///   only runs for `ICrossProgramInvocation.invoke_signed`. Reaching for
///   `AccountReader` does not exercise it.
///
/// ## Validation
///
///   - Selector hex re-verified via `cast keccak <signature>` against
///     `rome-evm-private/program/src/non_evm/cpi.rs` const block on
///     2026-05-13 and 2026-05-22 — matches `ACCOUNT_DATA_AT`,
///     `ACCOUNT_U64_AT`, `ACCOUNT_LAMPORTS`.
///   - Dispatch-variant claim verified against `cpi.rs:65,71-73` —
///     all three selectors route to `NonEvmCall::CrossStateEthCall`.
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
