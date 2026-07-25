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
