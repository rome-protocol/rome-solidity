// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {Convert} from "../convert.sol";

library SplTokenLib {
    bytes32 public constant SPL_TOKEN_PROGRAM =
        0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9; // Tokenkeg..
    bytes32 public constant SPL_TOKEN_2022_PROGRAM =
        0x06ddf6e1ee758fde18425dbce46ccddab61afc4d83b90d27febdf928d8a18bfc; // TokenzQd..

    uint256 internal constant SPL_MINT_LEN = 82;
    // Extension-bearing Token-2022 mints: base 82 padded to 165 + the
    // account-type byte + TLV. 83..165 can never be a mint (165 is a token
    // ACCOUNT length) — keeping that range rejected is the anti-confusion
    // boundary; the base fields parse identically at either shape.
    uint256 internal constant SPL_MINT_WITH_EXTENSIONS_MIN_LEN = 166;
    uint256 internal constant SPL_TOKEN_ACCOUNT_MIN_LEN = 72;

    error InvalidTokenAccountDataLength(uint256 actual, uint256 expected);
    error InvalidMintDataLength(uint256 actual, uint256 expected, bytes32 spl_token);
    error InvalidMintOwner(bytes32 spl_token, bytes32 owner);

    struct SplMint {
        Convert.COptionBytes32 mint_authority;
        uint64 supply;
        uint8 decimals;
        bool is_initialized;
        Convert.COptionBytes32 freeze_authority;
    }

    function load_mint(bytes32 token, address cpi_program) internal view returns (SplMint memory mint) {
        (, bytes32 owner,,,, bytes memory data) = ICrossProgramInvocation(cpi_program).account_info(token);
        check_mint_owner(owner, token);
        return parseMint(data, token);
    }

    function check_mint_owner(bytes32 owner, bytes32 token) internal pure {
        if (owner != SPL_TOKEN_PROGRAM && owner != SPL_TOKEN_2022_PROGRAM) {
            revert InvalidMintOwner(token, owner);
        }
    }

    function parseMint(bytes memory data, bytes32 token) internal pure returns (SplMint memory mint) {
        if (data.length != SPL_MINT_LEN && data.length < SPL_MINT_WITH_EXTENSIONS_MIN_LEN) {
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
