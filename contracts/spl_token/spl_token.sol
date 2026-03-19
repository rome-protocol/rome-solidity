// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {Convert} from "../convert.sol";

library SplTokenLib {
    struct AccountBase58 {
        string mint;
        string owner;
        uint64 amount;
        string delegate;
        ISplToken.AccountState state;
        bool is_native;
        uint64 native_value;
        uint64 delegated_amount;
        string close_authority;
    }

    bytes32 public constant SPL_TOKEN_PROGRAM =
    0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9; // Tokenkeg..

    uint256 internal constant SPL_MINT_LEN = 82;
    uint256 internal constant SPL_TOKEN_ACCOUNT_MIN_LEN = 72;

    error InvalidTokenAccountDataLength(uint256 actual, uint256 expected);

    struct SplMint {
        Convert.COptionBytes32 mint_authority;
        uint64 supply;
        uint8 decimals;
        bool is_initialized;
        Convert.COptionBytes32 freeze_authority;
    }

    error InvalidMintDataLength(uint256 actual, uint256 expected, bytes32 spl_token);
    error InvalidCOptionTag(uint32 tag);

    function program_id() internal view returns (string memory) {
        bytes32 key = SplToken.program_id();
        bytes memory b58 = SystemProgram.bytes32_to_base58(key);

        return string(b58);
    }

    function transfer(bytes32 from, bytes32 to, uint64 amount) internal {
        ISplToken.Seed[] memory seeds = new ISplToken.Seed[](0);
        (bool success, bytes memory result) = spl_token_address.delegatecall(
            abi.encodeWithSignature("transfer(bytes32,bytes32,uint64,(bytes)[])", from, to, amount, seeds)
        );

        require (success, string(Convert.revert_msg(result)));
    }

    function init_account(string memory acc, string memory mint, string memory owner) internal {
        bytes32 acc_ = SystemProgram.base58_to_bytes32(bytes(acc));
        bytes32 mint_ = SystemProgram.base58_to_bytes32(bytes(mint));
        bytes32 owner_ = SystemProgram.base58_to_bytes32(bytes(owner));

        SplToken.initialize_account3(acc_, mint_, owner_);
    }

    function load_mint(bytes32 token) internal view returns (SplMint memory mint) {
        ICrossProgramInvocation.AccountInfo memory spl_account = CrossProgramInvocation.account_info(token);
        return parseMint(spl_account.data, token);
    }

    function parseMint(bytes memory data, bytes32 token) internal pure returns (SplMint memory mint) {
        if (data.length != SPL_MINT_LEN) {
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

    function load_token_amount(bytes32 token_account_pubkey)
    internal
    view
    returns (uint64)
    {
        ICrossProgramInvocation.AccountInfo memory acc = CrossProgramInvocation.account_info(token_account_pubkey);
        return parse_token_account_amount(acc.data);
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

    function transfer(bytes32 from, bytes32 to, uint256 amount)
    internal
    returns (bool)
    {
        revert("transfer not implemented");
    }

    function allowance(bytes32 account, bytes32 spender)
    internal
    view
    returns (uint256)
    {
        revert("allowance not implemented");
    }

    function approve(bytes32 spender, uint256 value)
    internal
    returns (bool)
    {
        revert("approve not implemented");
    }

    function transferFrom(bytes32 from, bytes32 to, uint256 value)
    internal
    returns (bool)
    {
        revert("transferFrom not implemented");
    }
}
