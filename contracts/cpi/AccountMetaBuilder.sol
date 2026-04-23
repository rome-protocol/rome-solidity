// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICrossProgramInvocation} from "../interface.sol";
import {CpiError} from "./CpiError.sol";

/// @title AccountMetaBuilder
/// @notice Fluent builder for `ICrossProgramInvocation.AccountMeta[]` arrays.
/// @dev
///   Replaces the 146 hand-positioned `ICrossProgramInvocation.AccountMeta(...)`
///   rows across Meteora / Kamino / Drift with:
///
///     AccountMetaBuilder.Meta memory m = AccountMetaBuilder.alloc(5);
///     m.signer(owner)
///      .writable(reserve)
///      .readonly(market)
///      .writable(userAta)
///      .signerWritable(payer);
///     ICrossProgramInvocation.AccountMeta[] memory metas = m.build();
///
///   Design contract:
///   - `alloc(n)` pre-sizes the array to n slots. No dynamic resize.
///   - Each of the 4 flag methods writes to the next slot and advances `len`.
///   - Overrunning `alloc(n)` with an (n+1)-th write reverts with
///     `CpiError.InvalidAccountCount(got=n+1, want=n)`.
///   - `build()` returns the backing array sub-sliced to `len`. Underfilled
///     slots remain zero — this is intentional for adapters that conditionally
///     append (e.g. Kamino's 0-N refreshReserves tail). Adapters that demand
///     full-fill use `buildChecked()`.
///
///   Tests in `tests/cpi/AccountMetaBuilder.test.ts` exercise each path.
library AccountMetaBuilder {
    /// Fluent-builder backing state. Stored on the stack/memory of the caller;
    /// the struct fields are mutated by library methods via `using` attach.
    struct Meta {
        ICrossProgramInvocation.AccountMeta[] slots;
        uint256 len;
    }

    /// Pre-size the backing array. Subsequent flag methods advance `len`.
    function alloc(uint256 n) internal pure returns (Meta memory m) {
        m.slots = new ICrossProgramInvocation.AccountMeta[](n);
        m.len = 0;
    }

    /// is_signer=true, is_writable=false.
    function signer(Meta memory m, bytes32 key) internal pure returns (Meta memory) {
        _push(m, key, true, false);
        return m;
    }

    /// is_signer=false, is_writable=true.
    function writable(Meta memory m, bytes32 key) internal pure returns (Meta memory) {
        _push(m, key, false, true);
        return m;
    }

    /// is_signer=false, is_writable=false.
    function readonly(Meta memory m, bytes32 key) internal pure returns (Meta memory) {
        _push(m, key, false, false);
        return m;
    }

    /// is_signer=true, is_writable=true. Used by payer accounts (e.g. Drift
    /// `init_user` / `init_user_stats` funding).
    function signerWritable(Meta memory m, bytes32 key) internal pure returns (Meta memory) {
        _push(m, key, true, true);
        return m;
    }

    /// Return the backing array. If `len < slots.length`, the trailing slots
    /// remain zero-pubkey / false / false — intentional for conditional-append
    /// patterns (e.g. Kamino refreshReserves). Use `buildChecked()` if the
    /// adapter demands all slots populated.
    function build(Meta memory m)
        internal
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory out)
    {
        if (m.len == m.slots.length) {
            return m.slots;
        }
        out = new ICrossProgramInvocation.AccountMeta[](m.len);
        for (uint256 i = 0; i < m.len; i++) {
            out[i] = m.slots[i];
        }
    }

    /// Reverts if `len != slots.length` — used by builders that pre-size
    /// exactly and want to catch shape drift between IDL and Solidity.
    function buildChecked(Meta memory m)
        internal
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory)
    {
        if (m.len != m.slots.length) {
            revert CpiError.InvalidAccountCount(m.len, m.slots.length);
        }
        return m.slots;
    }

    function _push(
        Meta memory m,
        bytes32 key,
        bool isSigner,
        bool isWritable
    ) private pure {
        uint256 i = m.len;
        if (i >= m.slots.length) {
            // Overrun — attempted to write past alloc(n).
            revert CpiError.InvalidAccountCount(i + 1, m.slots.length);
        }
        m.slots[i] = ICrossProgramInvocation.AccountMeta({
            pubkey: key,
            is_signer: isSigner,
            is_writable: isWritable
        });
        m.len = i + 1;
    }
}
