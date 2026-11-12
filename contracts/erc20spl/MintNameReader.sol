// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MplTokenMetadataLib} from "../mpl_token_metadata/lib.sol";

/// @title MintNameReader
/// @notice The name and symbol a Solana mint asserts about itself, fail closed.
/// @dev Source, in order: (1) a Token-2022 mint whose MetadataPointer names the mint itself and
///      carries a TokenMetadata entry for this mint; (2) no pointer, or a pointer to the mint's
///      own Metaplex account (owned by Token Metadata, key MetadataV1, bytes 33-64 = this mint,
///      name <= 32, symbol <= 10, zero padding stripped); (3) any other pointer is
///      `ExternalPointer`, whoever owns the target. The mint must first walk clean: owner Token
///      or Token-2022, exact lengths, initialised, every Token-2022 extension exactly its
///      length, once, none unknown.
library MintNameReader {
    enum Source {
        None, // not walked clean, no entry, or a failed Metaplex check
        ExternalPointer, // pointer to an account that is neither the mint nor its Metaplex account
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

    struct Parsed {
        bool ok; // walked clean
        bytes32 mintAuthority; // zero when none
        bytes32 metadataAddress; // zero when no pointer
        uint256 metadataOffset; // zero when no TokenMetadata entry
    }

    /// @notice Name and symbol as stored (Metaplex padding stripped) and their source; nothing
    ///         is cut or checked.
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
            // No entry, or an entry for another mint, names nothing.
            if (off == 0 || _b32(d, off + 32) != mint) return (Source.None, "", "");
            uint256 nameLen = _u32(d, off + 64);
            name = _slice(d, off + 68, nameLen);
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
        // Symbol: u32 length (<= 10), then bytes; anything else is not Metaplex's.
        uint256 symAt = 69 + rawName;
        if (md.length - symAt < 4) return (Source.None, "", "");
        uint256 rawSym = _u32(md, symAt);
        if (rawSym > MPL_SYMBOL_MAX || md.length - symAt - 4 < rawSym) return (Source.None, "", "");
        // Metaplex zero-pads name (to 32) and symbol (to 10): strip trailing zeros.
        uint256 l = rawName;
        while (l != 0 && md[68 + l] == 0) l--;
        uint256 sl = rawSym;
        while (sl != 0 && md[symAt + 3 + sl] == 0) sl--;
        return (Source.Metaplex, _slice(md, 69, l), _slice(md, symAt + 4, sl));
    }

    /// @notice The mint's authority; `ok` is false unless the mint walks clean, zero when none.
    function mintAuthority(address cpi, bytes32 mint) internal view returns (bool ok, bytes32 authority) {
        (bool fetched, bytes32 owner, bytes memory d) = _fetch(cpi, mint);
        if (!fetched) return (false, bytes32(0));
        Parsed memory m = parse(owner, d);
        return (m.ok, m.mintAuthority);
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
            for (uint256 i = MINT_LEN; i < BASE_ACCOUNT_LEN; i++) {
                if (d[i] != 0) return m;
            }
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
        // Copies whole words; callers proved `from + len` is inside `b`.
        assembly ("memory-safe") {
            for { let off := 0 } lt(off, len) { off := add(off, 32) } {
                mstore(add(add(out, 32), off), mload(add(add(b, 32), add(from, off))))
            }
        }
    }
}
