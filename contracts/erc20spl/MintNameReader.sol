// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MplTokenMetadataLib} from "../mpl_token_metadata/lib.sol";
import {ISystemProgram, system_program_address} from "../interface.sol";

/// @title MintNameReader
/// @notice The name and symbol a Solana mint asserts about itself, fail closed.
/// @dev Source, in order: (1) a Token-2022 mint whose MetadataPointer names the mint itself and
///      carries a TokenMetadata entry for this mint; (2) no pointer, or a pointer to the mint's
///      own Metaplex account (owned by Token Metadata, key MetadataV1, bytes 33-64 = this mint,
///      name <= 32, symbol <= 10, zero padding stripped); (3) any other pointer is
///      `ExternalPointer`, whoever owns the target, and so is the mint's own TokenMetadata entry
///      behind a pointer that is not the mint when no Metaplex name is read. The mint must first
///      walk clean: owner Token
///      or Token-2022, exact lengths, initialised, every Token-2022 extension exactly its
///      length, once, none unknown.
library MintNameReader {
    enum Source {
        None, // not walked clean, no entry, or a failed Metaplex check
        ExternalPointer, // pointer elsewhere, or the mint's own entry behind a pointer that is not the mint with no Metaplex name
        Token2022, // the mint's own TokenMetadata entry
        Metaplex // the mint's own Metaplex account
    }

    /// @dev The Token program, TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA.
    bytes32 internal constant CLASSIC_PROGRAM = 0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9;
    /// @dev Token-2022, TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb.
    bytes32 internal constant PROGRAM_2022 = 0x06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc;
    /// @dev The Token Metadata program, metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s.
    bytes32 internal constant METAPLEX_PROGRAM = MplTokenMetadataLib.MPL_TOKEN_METADATA_PROGRAM_ID;

    uint256 private constant MINT_LEN = 82;
    uint256 private constant BASE_ACCOUNT_LEN = 165;
    uint256 private constant ACCOUNT_TYPE_MINT = 1;
    uint256 private constant MULTISIG_LEN = 355;

    uint256 private constant T_TRANSFER_FEE_CONFIG = 1;
    uint256 private constant T_MINT_CLOSE_AUTHORITY = 3;
    uint256 private constant T_DEFAULT_ACCOUNT_STATE = 6;
    uint256 private constant T_NON_TRANSFERABLE = 9;
    uint256 private constant T_PERMANENT_DELEGATE = 12;
    uint256 private constant T_TRANSFER_HOOK = 14;
    uint256 private constant T_METADATA_POINTER = 18;
    uint256 private constant T_TOKEN_METADATA = 19;
    uint256 private constant T_GROUP_POINTER = 20;
    uint256 private constant T_TOKEN_GROUP = 21;
    uint256 private constant T_GROUP_MEMBER_POINTER = 22;
    uint256 private constant T_TOKEN_GROUP_MEMBER = 23;
    uint256 private constant T_PAUSABLE_CONFIG = 26;
    uint256 private constant T_PERMISSIONED_BURN = 28;
    /// @dev Extension types accepted by presence alone, value not read: 4, 10, 16, 24, 25.
    uint256 private constant PRESENCE_ONLY = (1 << 4) | (1 << 10) | (1 << 16) | (1 << 24) | (1 << 25);

    uint256 private constant MPL_KEY_METADATA_V1 = 4;
    uint256 private constant MPL_NAME_MAX = 32;
    uint256 private constant MPL_SYMBOL_MAX = 10;

    /// @dev The Metaplex account read failed; a listed but absent account is not a failure.
    error MetaplexUnreadable();
    error PdaUnavailable();

    struct Parsed {
        bool ok; // walked clean
        bytes32 mintAuthority; // zero when none
        bytes32 metadataAddress; // zero when no pointer
        uint256 metadataOffset; // zero when no TokenMetadata entry
    }

    /// @notice Name and symbol as stored (Metaplex padding stripped) and their source; nothing
    ///         is cut or checked; reverts `MetaplexUnreadable` when the Metaplex read fails.
    function read(address cpi, bytes32 mint) internal view returns (Source source, bytes memory name, bytes memory symbol) {
        (bool ok, bytes32 owner, bytes memory d) = _fetch(cpi, mint);
        if (!ok) return (Source.None, "", "");
        Parsed memory m = parse(owner, d);
        if (!m.ok) return (Source.None, "", "");
        return _names(cpi, mint, d, m);
    }

    /// @notice `read` after one fetch and walk, for a mint whose authority is `authority`;
    ///         `isAuthority` is false (nothing else read) unless the mint walks clean with that authority.
    function readAsAuthority(address cpi, bytes32 mint, bytes32 authority)
        internal
        view
        returns (bool isAuthority, Source source, bytes memory name, bytes memory symbol)
    {
        (bool ok, bytes32 owner, bytes memory d) = _fetch(cpi, mint);
        if (!ok) return (false, Source.None, "", "");
        Parsed memory m = parse(owner, d);
        if (!m.ok || m.mintAuthority == bytes32(0) || m.mintAuthority != authority) {
            return (false, Source.None, "", "");
        }
        (source, name, symbol) = _names(cpi, mint, d, m);
        isAuthority = true;
    }

    function _names(address cpi, bytes32 mint, bytes memory d, Parsed memory m)
        private
        view
        returns (Source source, bytes memory name, bytes memory symbol)
    {
        bytes32 pointer = m.metadataAddress;
        if (pointer == mint) {
            uint256 off = m.metadataOffset;
            // No entry, or an entry for another mint, names nothing.
            if (off == 0 || _b32(d, off + 32) != mint) return (Source.None, "", "");
            uint256 nameLen = _u32(d, off + 64);
            name = _slice(d, off + 68, nameLen);
            uint256 symPos = off + 68 + nameLen;
            symbol = _slice(d, symPos + 4, _u32(d, symPos));
            return (Source.Token2022, name, symbol);
        }
        bytes32 metaplex = _metadataPda(mint);
        if (pointer != bytes32(0) && pointer != metaplex) return (Source.ExternalPointer, "", "");
        (bool ok, bytes32 mdOwner, bytes memory md) = _fetch(cpi, metaplex);
        if (!ok) revert MetaplexUnreadable();
        (source, name, symbol) = _metaplexName(mint, mdOwner, md);
        // The mint's own entry, with no Metaplex name behind it, is not read.
        uint256 own = m.metadataOffset;
        if (source == Source.None && own != 0 && _b32(d, own + 32) == mint) {
            return (Source.ExternalPointer, "", "");
        }
    }

    function _metaplexName(bytes32 mint, bytes32 owner, bytes memory md)
        private
        pure
        returns (Source source, bytes memory name, bytes memory symbol)
    {
        if (owner != METAPLEX_PROGRAM || md.length < 69 || uint8(md[0]) != MPL_KEY_METADATA_V1) {
            return (Source.None, "", "");
        }
        if (_b32(md, 33) != mint) return (Source.None, "", "");
        uint256 rawName = _u32(md, 65);
        if (rawName > MPL_NAME_MAX || md.length - 69 < rawName) return (Source.None, "", "");
        // Symbol: u32 length (<= 10), then bytes; anything else is not Metaplex's.
        uint256 symAt = 69 + rawName;
        if (md.length - symAt < 4) return (Source.None, "", "");
        uint256 rawSym = _u32(md, symAt);
        if (rawSym > MPL_SYMBOL_MAX || md.length - symAt - 4 < rawSym) return (Source.None, "", "");
        // Metaplex zero-pads name (to 32) and symbol (to 10): strip trailing zeros.
        return (
            Source.Metaplex,
            _slice(md, 69, _stripped(md, 69, rawName)),
            _slice(md, symAt + 4, _stripped(md, symAt + 4, rawSym))
        );
    }

    /// @dev The length of `b[at, at + len)` without its trailing zero bytes; `len` <= 32 and the
    ///      range is inside `b`.
    function _stripped(bytes memory b, uint256 at, uint256 len) private pure returns (uint256 l) {
        assembly ("memory-safe") {
            let w := and(mload(add(add(b, 32), at)), shl(sub(256, shl(3, len)), not(0)))
            if w {
                let z := 0
                if iszero(and(w, 0xffffffffffffffffffffffffffffffff)) {
                    z := 16
                    w := shr(128, w)
                }
                if iszero(and(w, 0xffffffffffffffff)) {
                    z := add(z, 8)
                    w := shr(64, w)
                }
                if iszero(and(w, 0xffffffff)) {
                    z := add(z, 4)
                    w := shr(32, w)
                }
                if iszero(and(w, 0xffff)) {
                    z := add(z, 2)
                    w := shr(16, w)
                }
                if iszero(and(w, 0xff)) { z := add(z, 1) }
                l := sub(32, z)
            }
        }
    }

    /// @dev The mint's Metaplex metadata address, with hand-written call data.
    function _metadataPda(bytes32 mint) private view returns (bytes32 pda) {
        bytes4 selector = ISystemProgram.find_program_address.selector;
        bytes32 program = METAPLEX_PROGRAM;
        address precompile = system_program_address;
        bool good;
        assembly ("memory-safe") {
            let m := mload(0x40)
            // 484 bytes of call data, rounded up to 512: memory this block owns.
            mstore(0x40, add(m, 512))
            mstore(m, selector)
            let a := add(m, 4)
            mstore(a, program)
            mstore(add(a, 0x20), 0x40)
            mstore(add(a, 0x40), 3)
            mstore(add(a, 0x60), 0x60)
            mstore(add(a, 0x80), 0xc0)
            mstore(add(a, 0xa0), 0x120)
            mstore(add(a, 0xc0), 0x20)
            mstore(add(a, 0xe0), 8)
            mstore(add(a, 0x100), "metadata")
            mstore(add(a, 0x120), 0x20)
            mstore(add(a, 0x140), 32)
            mstore(add(a, 0x160), program)
            mstore(add(a, 0x180), 0x20)
            mstore(add(a, 0x1a0), 32)
            mstore(add(a, 0x1c0), mint)
            let ok := staticcall(gas(), precompile, m, 484, m, 64)
            good := and(ok, eq(returndatasize(), 64))
            pda := mload(m)
        }
        if (!good) revert PdaUnavailable();
    }

    /// @notice Walks a mint account; `ok` stays false for anything it cannot place.
    function parse(bytes32 owner, bytes memory d) internal pure returns (Parsed memory m) {
        bool is2022 = owner == PROGRAM_2022;
        if (!is2022 && owner != CLASSIC_PROGRAM) return m;
        uint256 n = d.length;
        if (n < MINT_LEN || uint8(d[45]) != 1) return m;
        if ((!is2022 && n != MINT_LEN) || (is2022 && n > MINT_LEN && n < 166)) return m;
        (bool okAuthority, bytes32 authority) = _coption(d, 0);
        (bool okFreeze,) = _coption(d, 46);
        if (!okAuthority || !okFreeze) return m;
        m.mintAuthority = authority;
        if (is2022 && n > MINT_LEN) {
            // Zero padding, then account type "mint".
            // Bytes 82-164 as three words, the last masked to its first 19 bytes.
            uint256 pad;
            assembly ("memory-safe") {
                let p := add(add(d, 32), MINT_LEN)
                pad := or(or(mload(p), mload(add(p, 32))), and(mload(add(p, 64)), shl(104, not(0))))
            }
            if (pad != 0) return m;
            if (uint8(d[BASE_ACCOUNT_LEN]) != ACCOUNT_TYPE_MINT) return m;
            if (!_walk(m, d)) return m;
        }
        m.ok = true;
    }

    /// @dev Every entry from byte 166 to the end; false for an unplaceable entry or leftover byte.
    function _walk(Parsed memory m, bytes memory d) private pure returns (bool) {
        uint256 off = BASE_ACCOUNT_LEN + 1;
        uint256 n = d.length;
        uint32 seen;
        while (off < n) {
            // Token-2022 adds two zeros to a mint of exactly `Multisig::LEN` (355) bytes.
            if (off == MULTISIG_LEN && n == MULTISIG_LEN + 2 && d[off] == 0 && d[off + 1] == 0) break;
            if (n - off < 4) return false;
            uint256 t = _u16(d, off);
            uint256 len = _u16(d, off + 2);
            off += 4;
            if (n - off < len || t == 0 || t >= 32) return false;
            if (seen & uint32(1 << t) != 0) return false;
            seen |= uint32(1 << t);
            if (!_entry(m, d, t, off, len)) return false;
            off += len;
        }
        return true;
    }

    /// @dev One entry: exact length where the value is read, then the fields.
    function _entry(Parsed memory m, bytes memory d, uint256 t, uint256 off, uint256 len) private pure returns (bool) {
        if (t == T_TOKEN_METADATA) {
            if (!_metadataFits(d, off, len)) return false;
            m.metadataOffset = off;
            return true;
        }
        if (t == T_METADATA_POINTER) {
            if (len != 64) return false;
            m.metadataAddress = _b32(d, off + 32);
            return true;
        }
        if (t == T_DEFAULT_ACCOUNT_STATE) {
            if (len != 1) return false;
            uint8 s = uint8(d[off]);
            return s == 1 || s == 2;
        }
        if (t == T_PAUSABLE_CONFIG) return len == 33 && uint8(d[off + 32]) <= 1;
        uint256 want;
        if (t == T_TRANSFER_FEE_CONFIG) {
            want = 108;
        } else if (t == T_MINT_CLOSE_AUTHORITY || t == T_PERMANENT_DELEGATE || t == T_PERMISSIONED_BURN) {
            want = 32;
        } else if (t == T_NON_TRANSFERABLE) {
            want = 0;
        } else if (t == T_TRANSFER_HOOK || t == T_GROUP_POINTER || t == T_GROUP_MEMBER_POINTER) {
            want = 64;
        } else if (t == T_TOKEN_GROUP) {
            want = 80;
        } else if (t == T_TOKEN_GROUP_MEMBER) {
            want = 72;
        } else {
            // Presence-only types pass; account-side or unknown types are refused.
            return (PRESENCE_ONLY >> t) & 1 == 1;
        }
        return len == want;
    }

    /// @dev Borsh layout: update authority (32), mint (32), name, symbol, uri (u32 length + bytes
    ///      each), then a u32 count of (key, value) pairs. True if it takes exactly `len` bytes.
    function _metadataFits(bytes memory d, uint256 off, uint256 len) private pure returns (bool) {
        uint256 end = off + len;
        if (len < 64 + 12 + 4) return false;
        uint256 p = off + 64;
        for (uint256 s = 0; s < 3; s++) {
            if (end - p < 4) return false;
            uint256 l = _u32(d, p);
            p += 4;
            if (end - p < l) return false;
            p += l;
        }
        if (end - p < 4) return false;
        uint256 pairs = _u32(d, p);
        p += 4;
        for (uint256 i = 0; i < pairs; i++) {
            for (uint256 s = 0; s < 2; s++) {
                if (end - p < 4) return false;
                uint256 l = _u32(d, p);
                p += 4;
                if (end - p < l) return false;
                p += l;
            }
        }
        return p == end;
    }

    /// @dev One `account_info` read; `ok` is false if the precompile is absent, reverts or empty.
    function _fetch(address cpi, bytes32 account) private view returns (bool ok, bytes32 owner, bytes memory data) {
        if (cpi.code.length == 0) return (false, 0, "");
        (bool success, bytes memory ret) = cpi.staticcall(abi.encodeWithSignature("account_info(bytes32)", account));
        if (!success || ret.length < 224) return (false, 0, "");
        (, owner,,,, data) = abi.decode(ret, (uint64, bytes32, bool, bool, bool, bytes));
        ok = true;
    }

    /// @dev COption<Pubkey>: u32 tag (0 or 1), then the key; `ok` is false for any other tag.
    function _coption(bytes memory d, uint256 off) private pure returns (bool ok, bytes32 key) {
        uint256 tag = _u32(d, off);
        if (tag == 0) return (true, bytes32(0));
        if (tag != 1) return (false, bytes32(0));
        return (true, _b32(d, off + 4));
    }

    function _u16(bytes memory b, uint256 o) private pure returns (uint256 r) {
        require(b.length >= o + 2, "short");
        assembly ("memory-safe") {
            let x := shr(240, mload(add(add(b, 32), o)))
            r := or(shr(8, x), shl(8, and(x, 0xff)))
        }
    }

    function _u32(bytes memory b, uint256 o) private pure returns (uint256 r) {
        require(b.length >= o + 4, "short");
        assembly ("memory-safe") {
            let x := shr(224, mload(add(add(b, 32), o)))
            r := or(or(shr(24, x), and(shr(8, x), 0xff00)), or(and(shl(8, x), 0xff0000), shl(24, and(x, 0xff))))
        }
    }

    function _b32(bytes memory b, uint256 o) private pure returns (bytes32 r) {
        require(b.length >= o + 32, "short");
        assembly ("memory-safe") {
            r := mload(add(add(b, 32), o))
        }
    }

    function _slice(bytes memory b, uint256 from, uint256 len) private pure returns (bytes memory out) {
        out = new bytes(len);
        // Copies whole words; callers proved `from + len` is inside `b`.
        assembly ("memory-safe") {
            for { let off := 0 } lt(off, len) { off := add(off, 32) } {
                mstore(add(add(out, 32), off), mload(add(add(b, 32), add(from, off))))
            }
        }
    }
}
