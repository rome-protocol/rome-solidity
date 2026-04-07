// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {Convert} from "../convert.sol";

library SplTokenLib {
    bytes32 public constant SPL_TOKEN_PROGRAM =
    0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9; // Tokenkeg..

    uint256 internal constant SPL_MINT_LEN = 82;
    uint256 internal constant SPL_TOKEN_ACCOUNT_MIN_LEN = 72;
    uint256 internal constant SPL_TOKEN_ACCOUNT_DELEGATE_LEN = 129;

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

    function load_mint(bytes32 token, address cpi_program) internal view returns (SplMint memory mint) {
        (,,,,, bytes memory data) = ICrossProgramInvocation(cpi_program).account_info(token);
        return parseMint(data, token);
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

    function load_token_account_delegate(bytes32 token_account_pubkey, address cpi_program)
    internal
    view
    returns (bytes32 delegate, uint64 delegated_amount)
    {
        (,,,,, bytes memory data) = ICrossProgramInvocation(cpi_program).account_info(token_account_pubkey);
        return parse_token_account_delegate(data);
    }

    function parse_token_account_delegate(bytes memory data)
    internal
    pure
    returns (bytes32 delegate, uint64 delegated_amount)
    {
        if (data.length < SPL_TOKEN_ACCOUNT_DELEGATE_LEN) {
            revert InvalidTokenAccountDataLength(
                data.length,
                SPL_TOKEN_ACCOUNT_DELEGATE_LEN
            );
        }

        Convert.COptionBytes32 memory delegate_option;
        (delegate_option,) = Convert.read_coption_bytes32(data, 72);
        delegate = delegate_option.is_some ? delegate_option.value : bytes32(0);

        (delegated_amount,) = Convert.read_u64le(data, 121);
    }

    enum AuthorityType {
        MintTokens,
        FreezeAccount,
        AccountOwner,
        CloseAccount,
        TransferFeeConfig,
        WithheldWithdraw,
        CloseMint,
        InterestRate,
        PermanentDelegate,
        ConfidentialTransferMint,
        TransferHookProgramId,
        ConfidentialTransferFeeConfig,
        MetadataPointer,
        GroupPointer,
        GroupMemberPointer,
        ScaledUiAmount,
        Pause
    }

    uint256 constant MIN_SIGNERS = 1;
    uint256 constant MAX_SIGNERS = 11;

    // Replace with your actual constants if they already exist elsewhere.
    bytes32 constant SYSVAR_RENT_ID = 0x06a7d517192c5c51218cc94c3d4af17f58daee089ba1fd44e3dbd98a00000000;
    bytes32 constant SYSTEM_PROGRAM_ID = 0x0000000000000000000000000000000000000000000000000000000000000000;
    bytes32 constant NATIVE_MINT_ID = 0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001;

    error InvalidSignerCount(uint256 count);
    error InvalidAuthorityType(uint8 value);

    function initialize_mint(
        bytes32 token_program_id,
        bytes32 mint_pubkey,
        bytes32 mint_authority_pubkey,
        bool has_freeze_authority,
        bytes32 freeze_authority_pubkey,
        uint8 decimals
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        bytes memory data = _pack_initialize_mint(decimals, mint_authority_pubkey, has_freeze_authority, freeze_authority_pubkey);

        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](2);
        accounts[0] = _account_meta(mint_pubkey, false, true);
        accounts[1] = _account_meta(SYSVAR_RENT_ID, false, false);

        return (token_program_id, accounts, data);
    }

    function initialize_mint2(
        bytes32 token_program_id,
        bytes32 mint_pubkey,
        bytes32 mint_authority_pubkey,
        bool has_freeze_authority,
        bytes32 freeze_authority_pubkey,
        uint8 decimals
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        bytes memory data = _pack_initialize_mint2(decimals, mint_authority_pubkey, has_freeze_authority, freeze_authority_pubkey);

        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](1);
        accounts[0] = _account_meta(mint_pubkey, false, true);

        return (token_program_id, accounts, data);
    }

    function initialize_account(
        bytes32 token_program_id,
        bytes32 account_pubkey,
        bytes32 mint_pubkey,
        bytes32 owner_pubkey
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](4);
        accounts[0] = _account_meta(account_pubkey, false, true);
        accounts[1] = _account_meta(mint_pubkey, false, false);
        accounts[2] = _account_meta(owner_pubkey, false, false);
        accounts[3] = _account_meta(SYSVAR_RENT_ID, false, false);

        return (token_program_id, accounts, _pack_tag(1));
    }

    function initialize_account2(
        bytes32 token_program_id,
        bytes32 account_pubkey,
        bytes32 mint_pubkey,
        bytes32 owner_pubkey
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](3);
        accounts[0] = _account_meta(account_pubkey, false, true);
        accounts[1] = _account_meta(mint_pubkey, false, false);
        accounts[2] = _account_meta(SYSVAR_RENT_ID, false, false);

        return (token_program_id, accounts, _pack_tag_pubkey(16, owner_pubkey));
    }

    function initialize_account3(
        bytes32 token_program_id,
        bytes32 account_pubkey,
        bytes32 mint_pubkey,
        bytes32 owner_pubkey
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](2);
        accounts[0] = _account_meta(account_pubkey, false, true);
        accounts[1] = _account_meta(mint_pubkey, false, false);

        return (token_program_id, accounts, _pack_tag_pubkey(18, owner_pubkey));
    }

    function initialize_multisig(
        bytes32 token_program_id,
        bytes32 multisig_pubkey,
        bytes32[] memory signer_pubkeys,
        uint8 m
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        if (!is_valid_signer_index(m) || !is_valid_signer_index(uint8(signer_pubkeys.length)) || uint256(m) > signer_pubkeys.length) {
            revert InvalidSignerCount(signer_pubkeys.length);
        }

        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](2 + signer_pubkeys.length);
        accounts[0] = _account_meta(multisig_pubkey, false, true);
        accounts[1] = _account_meta(SYSVAR_RENT_ID, false, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[2 + i] = _account_meta(signer_pubkeys[i], false, false);
        }

        return (token_program_id, accounts, abi.encodePacked(uint8(2), m));
    }

    function initialize_multisig2(
        bytes32 token_program_id,
        bytes32 multisig_pubkey,
        bytes32[] memory signer_pubkeys,
        uint8 m
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        if (!is_valid_signer_index(m) || !is_valid_signer_index(uint8(signer_pubkeys.length)) || uint256(m) > signer_pubkeys.length) {
            revert InvalidSignerCount(signer_pubkeys.length);
        }

        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](1 + signer_pubkeys.length);
        accounts[0] = _account_meta(multisig_pubkey, false, true);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[1 + i] = _account_meta(signer_pubkeys[i], false, false);
        }

        return (token_program_id, accounts, abi.encodePacked(uint8(19), m));
    }

    function transfer(
        bytes32 token_program_id,
        bytes32 source_pubkey,
        bytes32 destination_pubkey,
        bytes32 authority_pubkey,
        bytes32[] memory signer_pubkeys,
        uint64 amount
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](3 + signer_pubkeys.length);
        accounts[0] = _account_meta(source_pubkey, false, true);
        accounts[1] = _account_meta(destination_pubkey, false, true);
        accounts[2] = _account_meta(authority_pubkey, signer_pubkeys.length == 0, false); // RomEVMAccount.pda
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[3 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, _pack_tag_u64(3, amount));
    }

    function approve(
        bytes32 token_program_id,
        bytes32 source_pubkey,
        bytes32 delegate_pubkey,
        bytes32 owner_pubkey,
        bytes32[] memory signer_pubkeys,
        uint64 amount
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](3 + signer_pubkeys.length);
        accounts[0] = _account_meta(source_pubkey, false, true);
        accounts[1] = _account_meta(delegate_pubkey, false, false);
        accounts[2] = _account_meta(owner_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[3 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, _pack_tag_u64(4, amount));
    }

    function revoke(
        bytes32 token_program_id,
        bytes32 source_pubkey,
        bytes32 owner_pubkey,
        bytes32[] memory signer_pubkeys
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](2 + signer_pubkeys.length);
        accounts[0] = _account_meta(source_pubkey, false, true);
        accounts[1] = _account_meta(owner_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[2 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, _pack_tag(5));
    }

    function set_authority(
        bytes32 token_program_id,
        bytes32 owned_pubkey,
        bool has_new_authority_pubkey,
        bytes32 new_authority_pubkey,
        AuthorityType authority_type,
        bytes32 owner_pubkey,
        bytes32[] memory signer_pubkeys
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](2 + signer_pubkeys.length);
        accounts[0] = _account_meta(owned_pubkey, false, true);
        accounts[1] = _account_meta(owner_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[2 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, bytes.concat(
                bytes1(uint8(6)),
                bytes1(uint8(authority_type)),
                _pack_pubkey_option(has_new_authority_pubkey, new_authority_pubkey)
            ));
    }

    function mint_to(
        bytes32 token_program_id,
        bytes32 mint_pubkey,
        bytes32 account_pubkey,
        bytes32 mint_authority_pubkey,
        bytes32[] memory signer_pubkeys,
        uint64 amount
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](3 + signer_pubkeys.length);
        accounts[0] = _account_meta(mint_pubkey, false, true);
        accounts[1] = _account_meta(account_pubkey, false, true);
        accounts[2] = _account_meta(mint_authority_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[3 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, _pack_tag_u64(7, amount));
    }

    function burn(
        bytes32 token_program_id,
        bytes32 account_pubkey,
        bytes32 mint_pubkey,
        bytes32 authority_pubkey,
        bytes32[] memory signer_pubkeys,
        uint64 amount
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](3 + signer_pubkeys.length);
        accounts[0] = _account_meta(account_pubkey, false, true);
        accounts[1] = _account_meta(mint_pubkey, false, true);
        accounts[2] = _account_meta(authority_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[3 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, _pack_tag_u64(8, amount));
    }

    function close_account(
        bytes32 token_program_id,
        bytes32 account_pubkey,
        bytes32 destination_pubkey,
        bytes32 owner_pubkey,
        bytes32[] memory signer_pubkeys
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](3 + signer_pubkeys.length);
        accounts[0] = _account_meta(account_pubkey, false, true);
        accounts[1] = _account_meta(destination_pubkey, false, true);
        accounts[2] = _account_meta(owner_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[3 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, _pack_tag(9));
    }

    function freeze_account(
        bytes32 token_program_id,
        bytes32 account_pubkey,
        bytes32 mint_pubkey,
        bytes32 freeze_authority_pubkey,
        bytes32[] memory signer_pubkeys
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](3 + signer_pubkeys.length);
        accounts[0] = _account_meta(account_pubkey, false, true);
        accounts[1] = _account_meta(mint_pubkey, false, false);
        accounts[2] = _account_meta(freeze_authority_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[3 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, _pack_tag(10));
    }

    function thaw_account(
        bytes32 token_program_id,
        bytes32 account_pubkey,
        bytes32 mint_pubkey,
        bytes32 freeze_authority_pubkey,
        bytes32[] memory signer_pubkeys
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](3 + signer_pubkeys.length);
        accounts[0] = _account_meta(account_pubkey, false, true);
        accounts[1] = _account_meta(mint_pubkey, false, false);
        accounts[2] = _account_meta(freeze_authority_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[3 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, _pack_tag(11));
    }

    function transfer_checked(
        bytes32 token_program_id,
        bytes32 source_pubkey,
        bytes32 mint_pubkey,
        bytes32 destination_pubkey,
        bytes32 authority_pubkey,
        bytes32[] memory signer_pubkeys,
        uint64 amount,
        uint8 decimals
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](4 + signer_pubkeys.length);
        accounts[0] = _account_meta(source_pubkey, false, true);
        accounts[1] = _account_meta(mint_pubkey, false, false);
        accounts[2] = _account_meta(destination_pubkey, false, true);
        accounts[3] = _account_meta(authority_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[4 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, _pack_tag_u64_u8(12, amount, decimals));
    }

    function approve_checked(
        bytes32 token_program_id,
        bytes32 source_pubkey,
        bytes32 mint_pubkey,
        bytes32 delegate_pubkey,
        bytes32 owner_pubkey,
        bytes32[] memory signer_pubkeys,
        uint64 amount,
        uint8 decimals
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](4 + signer_pubkeys.length);
        accounts[0] = _account_meta(source_pubkey, false, true);
        accounts[1] = _account_meta(mint_pubkey, false, false);
        accounts[2] = _account_meta(delegate_pubkey, false, false);
        accounts[3] = _account_meta(owner_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[4 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, _pack_tag_u64_u8(13, amount, decimals));
    }

    function mint_to_checked(
        bytes32 token_program_id,
        bytes32 mint_pubkey,
        bytes32 account_pubkey,
        bytes32 mint_authority_pubkey,
        bytes32[] memory signer_pubkeys,
        uint64 amount,
        uint8 decimals
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](3 + signer_pubkeys.length);
        accounts[0] = _account_meta(mint_pubkey, false, true);
        accounts[1] = _account_meta(account_pubkey, false, true);
        accounts[2] = _account_meta(mint_authority_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[3 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, _pack_tag_u64_u8(14, amount, decimals));
    }

    function burn_checked(
        bytes32 token_program_id,
        bytes32 account_pubkey,
        bytes32 mint_pubkey,
        bytes32 authority_pubkey,
        bytes32[] memory signer_pubkeys,
        uint64 amount,
        uint8 decimals
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](3 + signer_pubkeys.length);
        accounts[0] = _account_meta(account_pubkey, false, true);
        accounts[1] = _account_meta(mint_pubkey, false, true);
        accounts[2] = _account_meta(authority_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[3 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, _pack_tag_u64_u8(15, amount, decimals));
    }

    function sync_native(
        bytes32 token_program_id,
        bytes32 account_pubkey
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](1);
        accounts[0] = _account_meta(account_pubkey, false, true);

        return (token_program_id, accounts, _pack_tag(17));
    }

    function get_account_data_size(
        bytes32 token_program_id,
        bytes32 mint_pubkey,
        uint16[] memory extension_types
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](1);
        accounts[0] = _account_meta(mint_pubkey, false, false);

        return (token_program_id, accounts, bytes.concat(bytes1(uint8(21)), _pack_u16_array(extension_types)));
    }

    function initialize_mint_close_authority(
        bytes32 token_program_id,
        bytes32 mint_pubkey,
        bool has_close_authority,
        bytes32 close_authority
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](1);
        accounts[0] = _account_meta(mint_pubkey, false, true);

        return (token_program_id, accounts, bytes.concat(bytes1(uint8(25)), _pack_pubkey_option(has_close_authority, close_authority)));
    }

    function initialize_immutable_owner(
        bytes32 token_program_id,
        bytes32 token_account
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](1);
        accounts[0] = _account_meta(token_account, false, true);

        return (token_program_id, accounts, _pack_tag(22));
    }

    function amount_to_ui_amount(
        bytes32 token_program_id,
        bytes32 mint_pubkey,
        uint64 amount
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](1);
        accounts[0] = _account_meta(mint_pubkey, false, false);

        return (token_program_id, accounts, _pack_tag_u64(23, amount));
    }

    function ui_amount_to_amount(
        bytes32 token_program_id,
        bytes32 mint_pubkey,
        string memory ui_amount
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](1);
        accounts[0] = _account_meta(mint_pubkey, false, false);

        return (token_program_id, accounts, bytes.concat(bytes1(uint8(24)), bytes(ui_amount)));
    }

    function reallocate(
        bytes32 token_program_id,
        bytes32 account_pubkey,
        bytes32 payer,
        bytes32 owner_pubkey,
        bytes32[] memory signer_pubkeys,
        uint16[] memory extension_types
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](4 + signer_pubkeys.length);
        accounts[0] = _account_meta(account_pubkey, false, true);
        accounts[1] = _account_meta(payer, true, true);
        accounts[2] = _account_meta(SYSTEM_PROGRAM_ID, false, false);
        accounts[3] = _account_meta(owner_pubkey, signer_pubkeys.length == 0, false);
        for (uint256 i = 0; i < signer_pubkeys.length; i++) {
            accounts[4 + i] = _account_meta(signer_pubkeys[i], true, false);
        }

        return (token_program_id, accounts, bytes.concat(bytes1(uint8(29)), _pack_u16_array(extension_types)));
    }

    function create_native_mint(
        bytes32 token_program_id,
        bytes32 payer
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](3);
        accounts[0] = _account_meta(payer, true, true);
        accounts[1] = _account_meta(NATIVE_MINT_ID, false, true);
        accounts[2] = _account_meta(SYSTEM_PROGRAM_ID, false, false);

        return (token_program_id, accounts, _pack_tag(31));
    }

    function initialize_non_transferable_mint(
        bytes32 token_program_id,
        bytes32 mint_pubkey
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](1);
        accounts[0] = _account_meta(mint_pubkey, false, true);

        return (token_program_id, accounts, _pack_tag(32));
    }

    function initialize_permanent_delegate(
        bytes32 token_program_id,
        bytes32 mint_pubkey,
        bytes32 delegate
    ) internal pure returns (bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        ICrossProgramInvocation.AccountMeta[] memory accounts = new ICrossProgramInvocation.AccountMeta[](1);
        accounts[0] = _account_meta(mint_pubkey, false, true);

        return (token_program_id, accounts, _pack_tag_pubkey(35, delegate));
    }

    function is_valid_signer_index(uint8 index) internal pure returns (bool) {
        return index >= uint8(MIN_SIGNERS) && index <= uint8(MAX_SIGNERS);
    }

    function decode_instruction_type(bytes memory input) internal pure returns (uint8) {
        require(input.length > 0, "InvalidInstructionData");
        return uint8(input[0]);
    }

    function _pack_initialize_mint(
        uint8 decimals,
        bytes32 mint_authority,
        bool has_freeze_authority,
        bytes32 freeze_authority
    ) internal pure returns (bytes memory) {
        return bytes.concat(
            bytes1(uint8(0)),
            bytes1(decimals),
            abi.encodePacked(mint_authority),
            _pack_pubkey_option(has_freeze_authority, freeze_authority)
        );
    }

    function _pack_initialize_mint2(
        uint8 decimals,
        bytes32 mint_authority,
        bool has_freeze_authority,
        bytes32 freeze_authority
    ) internal pure returns (bytes memory) {
        return bytes.concat(
            bytes1(uint8(20)),
            bytes1(decimals),
            abi.encodePacked(mint_authority),
            _pack_pubkey_option(has_freeze_authority, freeze_authority)
        );
    }

    function _account_meta(
        bytes32 pubkey,
        bool is_signer,
        bool is_writable
    ) internal pure returns (ICrossProgramInvocation.AccountMeta memory) {
        return ICrossProgramInvocation.AccountMeta({
            pubkey: pubkey,
            is_signer: is_signer,
            is_writable: is_writable
        });
    }

    function _pack_tag(uint8 tag) internal pure returns (bytes memory) {
        return abi.encodePacked(tag);
    }

    function _pack_tag_pubkey(uint8 tag, bytes32 value) internal pure returns (bytes memory) {
        return abi.encodePacked(tag, value);
    }

    function _pack_tag_u64(uint8 tag, uint64 value) internal pure returns (bytes memory) {
        return bytes.concat(bytes1(tag), _le_u64(value));
    }

    function _pack_tag_u64_u8(uint8 tag, uint64 value, uint8 value2) internal pure returns (bytes memory) {
        return bytes.concat(bytes1(tag), _le_u64(value), bytes1(value2));
    }

    function _pack_pubkey_option(bool has_value, bytes32 value) internal pure returns (bytes memory) {
        if (!has_value) {
            return abi.encodePacked(uint8(0));
        }
        return abi.encodePacked(uint8(1), value);
    }

    function _pack_u16_array(uint16[] memory values) internal pure returns (bytes memory out) {
        for (uint256 i = 0; i < values.length; i++) {
            out = bytes.concat(out, _le_u16(values[i]));
        }
    }

    function _le_u16(uint16 value) internal pure returns (bytes memory) {
        bytes memory out = new bytes(2);
        out[0] = bytes1(uint8(value));
        out[1] = bytes1(uint8(value >> 8));
        return out;
    }

    function _le_u64(uint64 value) internal pure returns (bytes memory) {
        bytes memory out = new bytes(8);
        out[0] = bytes1(uint8(value));
        out[1] = bytes1(uint8(value >> 8));
        out[2] = bytes1(uint8(value >> 16));
        out[3] = bytes1(uint8(value >> 24));
        out[4] = bytes1(uint8(value >> 32));
        out[5] = bytes1(uint8(value >> 40));
        out[6] = bytes1(uint8(value >> 48));
        out[7] = bytes1(uint8(value >> 56));
        return out;
    }
}
