// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RomeNaming
/// @notice How Rome names a token it makes for a Solana mint (or for an EVM token's Solana mint): the name and the
///         symbol are exactly the origin's, unchanged. No prefix, no suffix and no cut: a bridged token reads the
///         same on every chain as the token it comes from.
///
/// @dev    Fail closed, on the WHOLE text. The order, for the name and for the symbol:
///           1. the text as read, whole;
///           2. refuse it when it is empty, is one of the placeholder texts for a name or symbol it could not read
///              ("NO_NAME", "NO_SYMBOL", "NOT_VALID_ENCODING") byte for byte, is not valid UTF-8 (a stray
///              continuation byte, a sequence cut short, an overlong form, a surrogate, a code point above
///              U+10FFFF), or holds a code point of Unicode 16.0.0's general categories Cc or Cf (235 code points
///              in 23 ranges: C0, DEL and C1 controls, bidi controls, zero-width and tag characters, the byte-order
///              mark and the soft hyphen);
///           3. return it as it is.
///         Only the exact placeholder texts are refused: "NO_SYMBOLS" is a symbol. The origin's own case and
///         letters are kept, "roETH" stays "roETH", and "USDT" stays "USDT".
///
///         `cut` stays for the one place that must cut: the Solana Metaplex metadata of a mint Rome makes holds
///         at most 32 bytes of name and 10 of symbol, so a caller that writes it cuts there, on a UTF-8 boundary,
///         with nothing added. No EVM side cuts.
///
///         The table is fixed at Unicode 16.0.0: a character a later version adds to Cf passes until a successor
///         factory is deployed. Every other character passes, unassigned ones included.
///
///         Cost: step 2 is linear in the text. ASCII is checked a 32-byte word at a time, and the walk goes byte by
///         byte only where a word holds a byte at or above 0x80; the table lookup runs only for the ten lead
///         bytes of characters that can be in it. A text too long to check inside a transaction's budget makes
///         the call revert, which is fail closed.
///
///         Other implementations of the same rule run the same vectors (tests/fixtures/asset-naming/vectors.json).
library RomeNaming {
    error BadName();
    error BadSymbol();

    /// @dev What Metaplex's token metadata holds: a name of at most 32 bytes and a symbol of at most 10. Only the
    ///      Solana-side metadata of a mint Rome makes is cut to these (see `cut`).
    uint256 internal constant METAPLEX_NAME_MAX = 32;
    uint256 internal constant METAPLEX_SYMBOL_MAX = 10;

    bytes32 private constant NO_NAME = keccak256("NO_NAME");
    bytes32 private constant NO_SYMBOL = keccak256("NO_SYMBOL");
    bytes32 private constant NOT_VALID_ENCODING = keccak256("NOT_VALID_ENCODING");

    uint256 private constant ONES = 0x0101010101010101010101010101010101010101010101010101010101010101;
    uint256 private constant HIGHS = 0x8080808080808080808080808080808080808080808080808080808080808080;
    uint256 private constant SPACES = 0x2020202020202020202020202020202020202020202020202020202020202020;
    uint256 private constant DELS = 0x7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f;
    uint256 private constant LETTER_A = 0x4141414141414141414141414141414141414141414141414141414141414141;

    /// @dev Bit (lead - 0xC2) is set for the lead bytes of characters that can be in the table: c2, d8, db, dc,
    ///      e0, e1, e2, ef, f0, f3. Every other character above U+007F passes without a lookup.
    uint256 private constant TABLE_LEADS =
        (1 << (0xC2 - 0xC2)) | (1 << (0xD8 - 0xC2)) | (1 << (0xDB - 0xC2)) | (1 << (0xDC - 0xC2))
            | (1 << (0xE0 - 0xC2)) | (1 << (0xE1 - 0xC2)) | (1 << (0xE2 - 0xC2)) | (1 << (0xEF - 0xC2))
            | (1 << (0xF0 - 0xC2)) | (1 << (0xF3 - 0xC2));

    // ---- the two names ----

    /// @notice The name as it is, or `BadName` when the whole name fails the checks.
    function romeName(string memory name) internal pure returns (string memory) {
        if (!acceptable(bytes(name), 7, NO_NAME)) revert BadName();
        return name;
    }

    /// @notice The symbol as it is, or `BadSymbol` when the whole symbol fails the checks.
    function romeSymbol(string memory symbol) internal pure returns (string memory) {
        if (!acceptable(bytes(symbol), 9, NO_SYMBOL)) revert BadSymbol();
        return symbol;
    }

    // ---- the checks on the whole text ----

    /// @notice Step 2: true when `b` is a name or symbol Rome will carry. `fallbackLength` and `fallbackHash` are
    ///         the byte length and keccak256 of the placeholder text for the kind ("NO_NAME", "NO_SYMBOL").
    function acceptable(bytes memory b, uint256 fallbackLength, bytes32 fallbackHash) internal pure returns (bool) {
        uint256 n = b.length;
        if (n == 0) return false;
        if (n == fallbackLength && keccak256(b) == fallbackHash) return false;
        if (n == 18 && keccak256(b) == NOT_VALID_ENCODING) return false;
        return _scan(b);
    }

    /// @dev Valid UTF-8 with no Cc or Cf code point. Aligned 32-byte words of plain printable ASCII are passed
    ///      whole; everything else is decoded one character at a time.
    function _scan(bytes memory b) private pure returns (bool) {
        uint256 n = b.length;
        uint256 i = 0;
        while (i < n) {
            if (i & 31 == 0) {
                uint256 w;
                assembly ("memory-safe") {
                    w := mload(add(add(b, 32), i))
                }
                uint256 rem = n - i;
                if (rem < 32) {
                    // The bytes past the end are not the text's: make them a letter.
                    uint256 keepBits = rem * 8;
                    w = (w & ~(type(uint256).max >> keepBits)) | (LETTER_A >> keepBits);
                }
                if (_plainWord(w)) {
                    i += 32;
                    continue;
                }
            }
            (bool ok, uint256 len) = _character(b, i, n);
            if (!ok) return false;
            i += len;
        }
        return true;
    }

    /// @dev True when every byte of `w` is printable ASCII, 0x20 to 0x7E. With no byte at or above 0x80, a byte
    ///      below 0x20 and a byte equal to 0x7F are found by the usual one-subtraction tests, which are exact for
    ///      whether such a byte exists.
    function _plainWord(uint256 w) private pure returns (bool) {
        if (w & HIGHS != 0) return false;
        unchecked {
            if ((w - SPACES) & ~w & HIGHS != 0) return false; // a byte below 0x20
            uint256 x = w ^ DELS;
            if ((x - ONES) & ~x & HIGHS != 0) return false; // a byte equal to 0x7F
        }
        return true;
    }

    /// @dev The character starting at byte `i`: whether it is well formed and acceptable, and its length.
    function _character(bytes memory b, uint256 i, uint256 n) private pure returns (bool, uint256) {
        uint256 c = uint8(b[i]);
        if (c < 0x80) return (c >= 0x20 && c != 0x7F, 1);
        if (c < 0xC2 || c > 0xF4) return (false, 1); // a continuation byte, an overlong lead, or past U+10FFFF
        uint256 cp;
        uint256 len;
        if (c < 0xE0) {
            if (n - i < 2) return (false, 1);
            uint256 c1 = uint8(b[i + 1]);
            if (c1 & 0xC0 != 0x80) return (false, 1);
            cp = ((c & 0x1F) << 6) | (c1 & 0x3F);
            len = 2;
        } else if (c < 0xF0) {
            if (n - i < 3) return (false, 1);
            uint256 c1 = uint8(b[i + 1]);
            uint256 c2 = uint8(b[i + 2]);
            // E0 needs A0..BF (no overlong), ED needs 80..9F (no surrogate), the rest 80..BF.
            uint256 lo = c == 0xE0 ? 0xA0 : 0x80;
            uint256 hi = c == 0xED ? 0x9F : 0xBF;
            if (c1 < lo || c1 > hi || c2 & 0xC0 != 0x80) return (false, 1);
            cp = ((c & 0x0F) << 12) | ((c1 & 0x3F) << 6) | (c2 & 0x3F);
            len = 3;
        } else {
            if (n - i < 4) return (false, 1);
            uint256 c1 = uint8(b[i + 1]);
            uint256 c2 = uint8(b[i + 2]);
            uint256 c3 = uint8(b[i + 3]);
            // F0 needs 90..BF (no overlong), F4 needs 80..8F (nothing past U+10FFFF), the rest 80..BF.
            uint256 lo = c == 0xF0 ? 0x90 : 0x80;
            uint256 hi = c == 0xF4 ? 0x8F : 0xBF;
            if (c1 < lo || c1 > hi || c2 & 0xC0 != 0x80 || c3 & 0xC0 != 0x80) return (false, 1);
            cp = ((c & 0x07) << 18) | ((c1 & 0x3F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F);
            len = 4;
        }
        if ((TABLE_LEADS >> (c - 0xC2)) & 1 == 1 && isControlOrFormat(cp)) return (false, len);
        return (true, len);
    }

    /// @notice True when `cp` is a code point of Unicode 16.0.0's general category Cc or Cf: 235 code points in 23
    ///         ranges, U+0000-001F, U+007F-009F, U+00AD, U+0600-0605, U+061C, U+06DD, U+070F, U+0890-0891, U+08E2,
    ///         U+180E, U+200B-200F, U+202A-202E, U+2060-2064, U+2066-206F, U+FEFF, U+FFF9-FFFB, U+110BD, U+110CD,
    ///         U+13430-1343F, U+1BCA0-1BCA3, U+1D173-1D17A, U+E0001 and U+E0020-E007F.
    function isControlOrFormat(uint256 cp) internal pure returns (bool) {
        if (cp < 0xA0) return cp < 0x20 || cp >= 0x7F;
        if (cp < 0x600) return cp == 0xAD;
        if (cp < 0x890) return cp <= 0x605 || cp == 0x61C || cp == 0x6DD || cp == 0x70F;
        if (cp < 0x2000) return cp <= 0x891 || cp == 0x8E2 || cp == 0x180E;
        if (cp < 0x2100) {
            return (cp >= 0x200B && cp <= 0x200F) || (cp >= 0x202A && cp <= 0x202E)
                || (cp >= 0x2060 && cp <= 0x2064) || (cp >= 0x2066 && cp <= 0x206F);
        }
        if (cp <= 0xFFFB) return cp == 0xFEFF || cp >= 0xFFF9;
        return cp == 0x110BD || cp == 0x110CD || (cp >= 0x13430 && cp <= 0x1343F) || (cp >= 0x1BCA0 && cp <= 0x1BCA3)
            || (cp >= 0x1D173 && cp <= 0x1D17A) || cp == 0xE0001 || (cp >= 0xE0020 && cp <= 0xE007F);
    }

    // ---- the cut ----

    /// @notice `b` cut to at most `maxBytes` bytes, on a UTF-8 boundary: a cut that would fall inside a character
    ///         falls before it. A text already within the limit is returned as it is. Copies a word at a time:
    ///         a byte loop is dear on Rome.
    function cut(bytes memory b, uint256 maxBytes) internal pure returns (bytes memory out) {
        if (b.length <= maxBytes) return b;
        uint256 end = maxBytes;
        // A continuation byte is 10xxxxxx: step back to the first byte of the character the cut is inside.
        while (end != 0 && (uint8(b[end]) & 0xC0) == 0x80) {
            end--;
        }
        out = new bytes(end);
        assembly ("memory-safe") {
            for { let off := 0 } lt(off, end) { off := add(off, 32) } {
                mstore(add(add(out, 32), off), mload(add(add(b, 32), off)))
            }
        }
    }
}
