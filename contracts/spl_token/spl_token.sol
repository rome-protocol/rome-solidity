// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {Convert} from "../convert.sol";
import {SolanaConstants} from "../cpi/SolanaConstants.sol";

library SplTokenLib {
    bytes32 public constant SPL_TOKEN_PROGRAM =
        0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9; // Tokenkeg..

    uint256 internal constant SPL_MINT_LEN = 82;

    /// The account is not owned by a token program, so its bytes are not a mint.
    error NotATokenMint(bytes32 token, bytes32 owner);
    uint256 internal constant SPL_TOKEN_ACCOUNT_MIN_LEN = 72;

    error InvalidTokenAccountDataLength(uint256 actual, uint256 expected);
    error InvalidMintDataLength(uint256 actual, uint256 expected, bytes32 spl_token);

    // ── Token-2022 extension TLV ────────────────────────────────────────────
    //
    // A 2022 mint pads its base layout to Account::LEN before the TLV region, so
    // the region can never be mistaken for a legacy token account. Hence 165 + 1
    // account-type byte: entries begin at 166, each `type:u16 | len:u16 | value`,
    // all little-endian, terminated by a zero type or by running out of buffer.
    uint256 internal constant TLV_START = 166;
    uint16 internal constant EXT_METADATA_POINTER = 18;
    uint16 internal constant EXT_TOKEN_METADATA = 19;

    /// Little-endian u16 at `off`. Reverts if it would read past the end, because
    /// these lengths come from an account someone else controls.
    function _le16(bytes memory data, uint256 off) private pure returns (uint16) {
        require(off + 2 <= data.length, "tlv: u16 out of bounds");
        return uint16(uint8(data[off])) | (uint16(uint8(data[off + 1])) << 8);
    }

    function _le32(bytes memory data, uint256 off) private pure returns (uint32) {
        require(off + 4 <= data.length, "tlv: u32 out of bounds");
        return uint32(uint8(data[off]))
            | (uint32(uint8(data[off + 1])) << 8)
            | (uint32(uint8(data[off + 2])) << 16)
            | (uint32(uint8(data[off + 3])) << 24);
    }

    /// Offset of an extension's payload, or `(false, 0)` when absent. Absence is a
    /// value here rather than an error: most mints carry neither of these.
    function _find_extension(bytes memory data, uint16 want)
        private
        pure
        returns (bool, uint256, uint256)
    {
        if (data.length < TLV_START + 4) {
            return (false, 0, 0);
        }
        uint256 off = TLV_START;
        while (off + 4 <= data.length) {
            uint16 t = _le16(data, off);
            uint16 len = _le16(data, off + 2);
            off += 4;
            if (t == 0 && len == 0) {
                break; // terminator
            }
            if (off + len > data.length) {
                break; // truncated entry — refuse to read past the end
            }
            if (t == want) {
                return (true, off, len);
            }
            off += len;
        }
        return (false, 0, 0);
    }

    /// Where the mint says its metadata lives. Self-referential — pointing at the
    /// mint itself — is the common shape, and means the TokenMetadata extension
    /// below carries the identity; a different address means it lives beside the
    /// mint, and the caller must read that account instead.
    function metadata_pointer(bytes memory data) internal pure returns (bool, bytes32) {
        (bool found, uint256 off, uint256 len) = _find_extension(data, EXT_METADATA_POINTER);
        if (!found || len < 64) {
            return (false, bytes32(0));
        }
        // authority (32), then metadata address (32).
        bytes32 addr;
        for (uint256 i = 0; i < 32; ++i) {
            addr |= bytes32(uint256(uint8(data[off + 32 + i])) << (8 * (31 - i)));
        }
        return (true, addr);
    }

    /// The name and symbol the mint itself asserts, from the TokenMetadata
    /// extension. Layout: update_authority (32), mint (32), then name, symbol and
    /// uri as u32-length-prefixed UTF-8.
    ///
    /// This is the identity a wrapper must present. The factory is permissionless
    /// and a wrapper's name is immutable once constructed, so a deployer-supplied
    /// label lets whoever registers a mint first name it permanently — including
    /// somebody else's token. Where the mint asserts an identity, that identity
    /// wins.
    function token_metadata(bytes memory data)
        internal
        pure
        returns (bool, string memory, string memory)
    {
        (bool found, uint256 off, uint256 len) = _find_extension(data, EXT_TOKEN_METADATA);
        if (!found || len < 72) {
            return (false, "", "");
        }
        uint256 end = off + len;
        uint256 p = off + 64; // past update_authority and mint

        (bool ok_name, string memory name, uint256 after_name) = _read_string(data, p, end);
        if (!ok_name) {
            return (false, "", "");
        }
        (bool ok_sym, string memory symbol, ) = _read_string(data, after_name, end);
        if (!ok_sym) {
            return (false, "", "");
        }
        return (true, name, symbol);
    }

    /// A u32-length-prefixed string, bounded by the extension's own end so a
    /// hostile length cannot walk into the next entry.
    function _read_string(bytes memory data, uint256 off, uint256 end)
        private
        pure
        returns (bool, string memory, uint256)
    {
        if (off + 4 > end) {
            return (false, "", off);
        }
        uint256 n = uint256(_le32(data, off));
        off += 4;
        if (off + n > end) {
            return (false, "", off);
        }
        bytes memory out = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            out[i] = data[off + i];
        }
        return (true, string(out), off + n);
    }

    struct SplMint {
        Convert.COptionBytes32 mint_authority;
        uint64 supply;
        uint8 decimals;
        bool is_initialized;
        Convert.COptionBytes32 freeze_authority;
    }

    /// @dev The wrappers no longer use this — they take `decimals` from
    ///      `mint_info`, so no Solidity code parses mint bytes on their path.
    ///      It remains for general callers and is correct for Token-2022, whose
    ///      base layout is byte-identical and whose extensions trail it.
    function load_mint(bytes32 token, address cpi_program) internal view returns (SplMint memory mint) {
        (, bytes32 owner,,,, bytes memory data) = ICrossProgramInvocation(cpi_program).account_info(token);
        if (owner != SolanaConstants.SPL_TOKEN_PROGRAM && owner != SolanaConstants.TOKEN_2022_PROGRAM) {
            revert NotATokenMint(token, owner);
        }
        return parseMint(data, token);
    }

    function parseMint(bytes memory data, bytes32 token) internal pure returns (SplMint memory mint) {
        // A Token-2022 mint with extensions is >= SPL_MINT_LEN + 1: the base
        // layout parsed below is byte-identical, and the account-type byte plus
        // the TLV region trail it. An exact-length check here was the single
        // thing that rejected every extension-bearing mint.
        if (data.length < SPL_MINT_LEN) {
            revert InvalidMintDataLength(data.length, SPL_MINT_LEN, token);
        }

        uint256 offset = 0;

        (mint.mint_authority, offset) = Convert.read_coption_bytes32(data, offset);
        (mint.supply, offset) = Convert.read_u64le(data, offset);
        (mint.decimals, offset) = Convert.read_u8(data, offset);

        uint8 initialized;
        (initialized, offset) = Convert.read_u8(data, offset);
        mint.is_initialized = initialized != 0;

        (mint.freeze_authority, offset) = Convert.read_coption_bytes32(data, offset);

        return mint;
    }

    function load_token_amount(bytes32 token_account_pubkey, address cpi_program)
        internal
        view
        returns (uint64)
    {
        (,,,,, bytes memory data) = ICrossProgramInvocation(cpi_program).account_info(token_account_pubkey);
        return parse_token_account_amount(data);
    }

    function parse_token_account_amount(bytes memory data)
        internal
        pure
        returns (uint64 amount)
    {
        if (data.length < SPL_TOKEN_ACCOUNT_MIN_LEN) {
            revert InvalidTokenAccountDataLength(
                data.length,
                SPL_TOKEN_ACCOUNT_MIN_LEN
            );
        }

        (amount,) = Convert.read_u64le(data, 64);
    }
}
