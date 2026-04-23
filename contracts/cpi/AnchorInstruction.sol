// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Convert} from "../convert.sol";

/// @title AnchorInstruction
/// @notice Anchor instruction-data encoding primitives.
/// @dev
///   Anchor's wire format is: `discriminator (8 bytes) ++ args_borsh`.
///
///   `discriminator(name)` returns `bytes8(sha256("global:" ++ name))` — the
///   canonical derivation published in every Anchor IDL. Adapters cache this
///   as a `bytes8 constant` at authoring time and use the
///   `*DiscFromName()` oracle in tests to verify the constant matches.
///
///   Borsh LE primitives: u16, u32, i32, i64, bool. `u64` delegates to
///   `Convert.u64le` in rome-solidity/contracts/convert.sol (do not
///   re-implement per §7 Task 4).
///
///   `optionSome` / `optionNone` wrap the Anchor `Option<T>` convention:
///     - None   : `[0x00]`
///     - Some(v): `[0x01, ...v_borsh]`
///
///   Tests in `tests/cpi/AnchorInstruction.test.ts` cross-check the three
///   live-adapter discriminators (Meteora swap, Kamino deposit, Drift
///   place_perp_order).
library AnchorInstruction {
    // ──────────────────────────────────────────────────────────────────
    // Discriminator
    // ──────────────────────────────────────────────────────────────────

    /// Anchor discriminator for a given instruction name. Used at test time
    /// to verify committed `bytes8 constant` values.
    function discriminator(string memory name) internal pure returns (bytes8) {
        return bytes8(sha256(abi.encodePacked("global:", name)));
    }

    // ──────────────────────────────────────────────────────────────────
    // withDisc — prefix the 8-byte discriminator
    // ──────────────────────────────────────────────────────────────────

    /// Prefix the 8-byte discriminator onto an empty data payload. Used for
    /// zero-arg instructions (e.g. Kamino `refresh_reserve` / `refresh_obligation`).
    function withDisc(bytes8 disc) internal pure returns (bytes memory) {
        return abi.encodePacked(disc);
    }

    /// Prefix the 8-byte discriminator onto the caller's borsh-encoded args.
    function withDisc(bytes8 disc, bytes memory args)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(disc, args);
    }

    // ──────────────────────────────────────────────────────────────────
    // Option<T>
    // ──────────────────────────────────────────────────────────────────

    /// Anchor Option<T>::None wire encoding: single zero byte.
    function optionNone() internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(0));
    }

    /// Anchor Option<T>::Some(value) wire encoding: 0x01 tag + value bytes.
    function optionSome(bytes memory value) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(1), value);
    }

    // ──────────────────────────────────────────────────────────────────
    // Borsh LE primitives
    //
    // u64 lives in rome-solidity/contracts/convert.sol (Convert.u64le) —
    // this library delegates, never re-implements.
    // ──────────────────────────────────────────────────────────────────

    function u16le(uint16 x) internal pure returns (bytes2 out) {
        out = bytes2(uint16((x >> 8) & 0xff) | uint16((x & 0xff) << 8));
    }

    function u32le(uint32 x) internal pure returns (bytes4) {
        bytes memory b = new bytes(4);
        b[0] = bytes1(uint8(x));
        b[1] = bytes1(uint8(x >> 8));
        b[2] = bytes1(uint8(x >> 16));
        b[3] = bytes1(uint8(x >> 24));
        return bytes4(b);
    }

    function i32le(int32 x) internal pure returns (bytes4) {
        return u32le(uint32(x));
    }

    /// Delegates the u64 path to Convert.u64le — adapters should import both
    /// `AnchorInstruction` and `Convert` (the latter is already a dependency
    /// of every CPI adapter via rome-solidity).
    function u64le(uint64 x) internal pure returns (bytes8) {
        return Convert.u64le(x);
    }

    function i64le(int64 x) internal pure returns (bytes8) {
        return Convert.u64le(uint64(x));
    }

    function boolle(bool x) internal pure returns (bytes1) {
        return bytes1(x ? uint8(1) : uint8(0));
    }
}
