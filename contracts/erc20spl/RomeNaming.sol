// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title RomeNaming
/// @notice Rome's naming rule: name = origin name cut to 25 bytes + " (Rome)", symbol = origin
///         symbol cut to 10 bytes. Both fit Metaplex (32 and 10 bytes).
/// @dev Fails closed on the WHOLE text before the cut, so the placeholder texts a reader emits
///      ("NO_NAME", "NO_SYMBOL", "NOT_VALID_ENCODING") are caught. Refused: empty, a placeholder,
///      invalid UTF-8, or a Unicode 16.0.0 Cc/Cf code point (a later Cf addition passes until a
///      successor factory). A text too long to check in one transaction reverts.
library RomeNaming {
    error BadName();
    error BadSymbol();

    uint256 internal constant NAME_CUT = 25;
    uint256 internal constant SYMBOL_CUT = 10;

    bytes32 private constant NO_NAME = keccak256("NO_NAME");
    bytes32 private constant NO_SYMBOL = keccak256("NO_SYMBOL");
    bytes32 private constant NOT_VALID_ENCODING = keccak256("NOT_VALID_ENCODING");

    uint256 private constant ONES = 0x0101010101010101010101010101010101010101010101010101010101010101;
    uint256 private constant HIGHS = 0x8080808080808080808080808080808080808080808080808080808080808080;
    uint256 private constant SPACES = 0x2020202020202020202020202020202020202020202020202020202020202020;
    uint256 private constant DELS = 0x7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f;
    uint256 private constant LETTER_A = 0x4141414141414141414141414141414141414141414141414141414141414141;

    /// @dev Bit (lead - 0xC2) is set for lead bytes of characters that can be in the table: c2,
    ///      d8, db, dc, e0, e1, e2, ef, f0, f3. Other characters above U+007F pass unlooked.
    uint256 private constant TABLE_LEADS =
        (1 << (0xC2 - 0xC2)) | (1 << (0xD8 - 0xC2)) | (1 << (0xDB - 0xC2)) | (1 << (0xDC - 0xC2))
            | (1 << (0xE0 - 0xC2)) | (1 << (0xE1 - 0xC2)) | (1 << (0xE2 - 0xC2)) | (1 << (0xEF - 0xC2))
            | (1 << (0xF0 - 0xC2)) | (1 << (0xF3 - 0xC2));

    /// @notice "<name cut to 25 bytes> (Rome)"; reverts `BadName` if the whole name is refused.
    function romeName(string memory name) internal pure returns (string memory) {
        return romeNameCut(name, NAME_CUT);
    }

    /// @notice The symbol cut to 10 bytes; reverts `BadSymbol` if the whole symbol is refused.
    function romeSymbol(string memory symbol) internal pure returns (string memory) {
        return romeSymbolCut(symbol, SYMBOL_CUT);
    }

    /// @dev `romeName` with the cut as a parameter, for tests.
    function romeNameCut(string memory name, uint256 cutBytes) internal pure returns (string memory) {
        bytes memory b = bytes(name);
        if (!acceptable(b, 7, NO_NAME)) revert BadName();
        bytes memory kept = cut(b, cutBytes);
        if (kept.length == 0) revert BadName();
        return string.concat(string(kept), " (Rome)");
    }

    /// @dev `romeSymbol` with the cut as a parameter, for tests.
    function romeSymbolCut(string memory symbol, uint256 cutBytes) internal pure returns (string memory) {
        bytes memory b = bytes(symbol);
        if (!acceptable(b, 9, NO_SYMBOL)) revert BadSymbol();
        bytes memory kept = cut(b, cutBytes);
        if (kept.length == 0) revert BadSymbol();
        return string(kept);
    }

    /// @notice True when `b` is a name or symbol Rome will carry; `fallbackLength` and
    ///         `fallbackHash` identify the placeholder text for this kind.
    function acceptable(bytes memory b, uint256 fallbackLength, bytes32 fallbackHash) internal pure returns (bool) {
        uint256 n = b.length;
        if (n == 0) return false;
        if (n == fallbackLength && keccak256(b) == fallbackHash) return false;
        if (n == 18 && keccak256(b) == NOT_VALID_ENCODING) return false;
        return _scan(b);
    }

    /// @dev Valid UTF-8 with no Cc/Cf code point; aligned all-printable-ASCII words pass whole.
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
                    // Bytes past the end are not the text's: make them a letter.
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

    /// @dev True when every byte of `w` is 0x20 to 0x7E.
    function _plainWord(uint256 w) private pure returns (bool) {
        if (w & HIGHS != 0) return false;
        unchecked {
            if ((w - SPACES) & ~w & HIGHS != 0) return false; // a byte below 0x20
            uint256 x = w ^ DELS;
            if ((x - ONES) & ~x & HIGHS != 0) return false; // a byte equal to 0x7F
        }
        return true;
    }

    /// @dev The character at byte `i`: (well formed and acceptable, its length).
    function _character(bytes memory b, uint256 i, uint256 n) private pure returns (bool, uint256) {
        uint256 c = uint8(b[i]);
        if (c < 0x80) return (c >= 0x20 && c != 0x7F, 1);
        // A continuation byte, an overlong lead, or past U+10FFFF.
        if (c < 0xC2 || c > 0xF4) return (false, 1);
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
            // F0 needs 90..BF (no overlong), F4 needs 80..8F (<= U+10FFFF), the rest 80..BF.
            uint256 lo = c == 0xF0 ? 0x90 : 0x80;
            uint256 hi = c == 0xF4 ? 0x8F : 0xBF;
            if (c1 < lo || c1 > hi || c2 & 0xC0 != 0x80 || c3 & 0xC0 != 0x80) return (false, 1);
            cp = ((c & 0x07) << 18) | ((c1 & 0x3F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F);
            len = 4;
        }
        if ((TABLE_LEADS >> (c - 0xC2)) & 1 == 1 && isControlOrFormat(cp)) return (false, len);
        return (true, len);
    }

    /// @notice True for Unicode 16.0.0 general category Cc or Cf (235 code points).
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

    /// @notice `b` cut to at most `maxBytes` bytes on a UTF-8 boundary, never mid-character.
    function cut(bytes memory b, uint256 maxBytes) internal pure returns (bytes memory out) {
        if (b.length <= maxBytes) return b;
        uint256 end = maxBytes;
        // A continuation byte is 10xxxxxx: step back to the first byte of the cut character.
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
