// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MplTokenMetadataLib} from "../mpl_token_metadata/lib.sol";

/// @title MintNameReader
/// @notice Reads the name a Solana mint asserts about itself, fail closed (the wrapper factory's metadata read).
///
/// @dev    The name comes from exactly one of three sources, in this order:
///           1. The mint's own entry: a Token-2022 mint whose MetadataPointer names the mint itself carries a
///              TokenMetadata entry, which must name this mint.
///           2. Metaplex: no pointer, or a pointer that names the mint's own Metaplex metadata account. That
///              account is accepted only if the Token Metadata program owns it, its first byte is `MetadataV1`,
///              bytes 33 to 64 are this mint, the name is at most 32 bytes and the symbol at most 10, both inside
///              the account; Metaplex's zero padding is stripped.
///           3. Any other pointer target is refused (`ExternalPointer`), whatever the account holds and whoever
///              owns it: a pointer to an account outside Token-2022 and Metaplex names nothing that can be bound
///              to the mint safely.
///         A mint that is not walked clean has no name: the owner must be the Token program or Token-2022, the
///         account the length of its program's mint, an initialised mint, and every Token-2022 extension entry
///         exactly the length its type has, once each, with no byte left over and no unknown type.
///
///         The layouts are the Token program's (82-byte mint) and Token-2022's (the mint padded to 165 bytes, an
///         account type byte at 165, then entries of a u16 type, a u16 length and the value, little endian). The
///         extension numbers are those of spl-token-2022's `ExtensionType`. The rule and the walk are the same
///         as rome-agglayer's `MintReader`, held equal by the shared vectors
///         (tests/fixtures/asset-naming/vectors.json).
library MintNameReader {
    enum Source {
        None, // no name: the mint was not walked clean, or has no entry, or its Metaplex account failed a check
        ExternalPointer, // a metadata pointer to an account that is neither the mint nor its own Metaplex account
        Token2022, // the mint's own TokenMetadata entry
        Metaplex // the mint's own Metaplex metadata account
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
    /// @dev Token-2022 adds two zero bytes to a mint whose length would be exactly this (`Multisig::LEN`, 355).
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
    /// @dev Entries classed by presence, whose value is not read: confidential transfer (4), interest-bearing (10),
    ///      confidential transfer fee (16), confidential mint and burn (24), scaled UI amount (25).
    uint256 private constant PRESENCE_ONLY = (1 << 4) | (1 << 10) | (1 << 16) | (1 << 24) | (1 << 25);

    uint256 private constant MPL_KEY_METADATA_V1 = 4;
    uint256 private constant MPL_NAME_MAX = 32;
    uint256 private constant MPL_SYMBOL_MAX = 10;

    struct Parsed {
        bool ok; // the mint was walked clean
        bytes32 mintAuthority; // zero when none
        bytes32 metadataAddress; // the MetadataPointer's address, zero when no pointer
        uint256 metadataOffset; // where the TokenMetadata value starts, zero when none
    }

    // ----- reads -----

    /// @notice The mint's own name and symbol, as stored (Metaplex's padding stripped), and where they came from.
    ///         Nothing is cut, checked or changed here.
    function read(address cpi, bytes32 mint) internal view returns (Source source, bytes memory name, bytes memory symbol) {
        (bool ok, bytes32 owner, bytes memory d) = _fetch(cpi, mint);
        if (!ok) return (Source.None, "", "");
        Parsed memory m = parse(owner, d);
        if (!m.ok) return (Source.None, "", "");
        (bytes32 metaplex,) = MplTokenMetadataLib.find_metadata_pda(mint, METAPLEX_PROGRAM);
        if (m.metadataAddress != bytes32(0) && m.metadataAddress != mint && m.metadataAddress != metaplex) {
            return (Source.ExternalPointer, "", "");
        }
        if (m.metadataAddress == mint) {
            uint256 off = m.metadataOffset;
            // A pointer to itself with no entry, or an entry made for another mint, names nothing.
            if (off == 0 || _b32(d, off + 32) != mint) return (Source.None, "", "");
            uint256 nameLen = _u32(d, off + 64);
            name = _slice(d, off + 68, nameLen);
            // The entry was walked whole, so the symbol's length and bytes follow the name inside it.
            uint256 symPos = off + 68 + nameLen;
            symbol = _slice(d, symPos + 4, _u32(d, symPos));
            return (Source.Token2022, name, symbol);
        }
        bytes32 mdOwner;
        bytes memory md;
        (ok, mdOwner, md) = _fetch(cpi, metaplex);
        if (!ok || mdOwner != METAPLEX_PROGRAM || md.length < 69 || uint8(md[0]) != MPL_KEY_METADATA_V1) {
            return (Source.None, "", "");
        }
        if (_b32(md, 33) != mint) return (Source.None, "", "");
        uint256 rawName = _u32(md, 65);
        if (rawName > MPL_NAME_MAX || md.length - 69 < rawName) return (Source.None, "", "");
        // The symbol follows the name: a u32 length (at most 10) and the bytes. An account with no such field, or a
        // symbol over the limit or past the end, is not Metaplex's and names nothing.
        uint256 symAt = 69 + rawName;
        if (md.length - symAt < 4) return (Source.None, "", "");
        uint256 rawSym = _u32(md, symAt);
        if (rawSym > MPL_SYMBOL_MAX || md.length - symAt - 4 < rawSym) return (Source.None, "", "");
        // Metaplex pads a name (to 32) and a symbol (to 10) with zero bytes: each ends at its last byte that is not zero.
        uint256 l = rawName;
        while (l != 0 && md[68 + l] == 0) l--;
        uint256 sl = rawSym;
        while (sl != 0 && md[symAt + 3 + sl] == 0) sl--;
        return (Source.Metaplex, _slice(md, 69, l), _slice(md, symAt + 4, sl));
    }

    /// @notice The mint's authority: `ok` is false when the account is not a mint walked clean; `authority` is zero
    ///         when the mint has none.
    function mintAuthority(address cpi, bytes32 mint) internal view returns (bool ok, bytes32 authority) {
        (bool fetched, bytes32 owner, bytes memory d) = _fetch(cpi, mint);
        if (!fetched) return (false, bytes32(0));
        Parsed memory m = parse(owner, d);
        return (m.ok, m.mintAuthority);
    }

    // ----- the walk -----

    /// @notice Walks a mint account: its owner, its base layout and every Token-2022 entry. `ok` stays false for
    ///         anything it cannot place.
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
            // The padding between the mint and the account type is all zero, and the type says "mint".
            for (uint256 i = MINT_LEN; i < BASE_ACCOUNT_LEN; i++) {
                if (d[i] != 0) return m;
            }
            if (uint8(d[BASE_ACCOUNT_LEN]) != ACCOUNT_TYPE_MINT) return m;
            if (!_walk(m, d)) return m;
        }
        m.ok = true;
    }

    /// @dev Every entry from byte 166 to the end. False for an entry it cannot place or a byte left over.
    function _walk(Parsed memory m, bytes memory d) private pure returns (bool) {
        uint256 off = BASE_ACCOUNT_LEN + 1;
        uint256 n = d.length;
        uint32 seen;
        while (off < n) {
            // The two bytes Token-2022 adds to a mint of exactly 355 bytes: the entries end at 355, then two zeros.
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

    /// @dev One entry: its exact length where the value is read, then the fields.
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
            // 1 initialised, 2 frozen
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
            // Presence only, or a type that cannot be on a mint (an account-side one: 2, 5, 7, 8, 11, 13, 15,
            // 17, 27) or is not known here.
            return (PRESENCE_ONLY >> t) & 1 == 1;
        }
        return len == want;
    }

    /// @dev The Token-2022 metadata entry's value is borsh: update authority (32), mint (32), name, symbol, uri (each a
    ///      u32 length and bytes), then a u32 count of (key, value) string pairs. True when it takes exactly `len` bytes.
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

    // ----- plumbing -----

    /// @dev One `account_info` read. `ok` is false when the precompile is not there, reverts, or answers nothing.
    function _fetch(address cpi, bytes32 account) private view returns (bool ok, bytes32 owner, bytes memory data) {
        if (cpi.code.length == 0) return (false, 0, "");
        (bool success, bytes memory ret) = cpi.staticcall(abi.encodeWithSignature("account_info(bytes32)", account));
        if (!success || ret.length < 224) return (false, 0, "");
        (, owner,,,, data) = abi.decode(ret, (uint64, bytes32, bool, bool, bool, bytes));
        ok = true;
    }

    /// @dev A COption<Pubkey>: a u32 tag, 0 or 1, then the key (zeros when none). `ok` false for any other tag.
    function _coption(bytes memory d, uint256 off) private pure returns (bool ok, bytes32 key) {
        uint256 tag = _u32(d, off);
        if (tag == 0) return (true, bytes32(0));
        if (tag != 1) return (false, bytes32(0));
        return (true, _b32(d, off + 4));
    }

    function _u16(bytes memory b, uint256 o) private pure returns (uint256) {
        return uint256(uint8(b[o])) | (uint256(uint8(b[o + 1])) << 8);
    }

    function _u32(bytes memory b, uint256 o) private pure returns (uint256) {
        return _u16(b, o) | (_u16(b, o + 2) << 16);
    }

    function _b32(bytes memory b, uint256 o) private pure returns (bytes32 r) {
        require(b.length >= o + 32, "short");
        assembly ("memory-safe") {
            r := mload(add(add(b, 32), o))
        }
    }

    function _slice(bytes memory b, uint256 from, uint256 len) private pure returns (bytes memory out) {
        out = new bytes(len);
        // A word at a time: a byte loop is dear on Rome. `from + len` is inside `b` (the callers checked), and a
        // last word may read a few bytes past it, which are not copied into the string's length.
        assembly ("memory-safe") {
            for { let off := 0 } lt(off, len) { off := add(off, 32) } {
                mstore(add(add(out, 32), off), mload(add(add(b, 32), add(from, off))))
            }
        }
    }
}
