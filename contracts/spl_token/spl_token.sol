// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {Convert} from "../convert.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";

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

    /// @dev Transfer uint256 amount by casting to uint64 and delegatecalling the SPL precompile
    function transfer(bytes32 from, bytes32 to, uint256 amount)
    internal
    returns (bool)
    {
        require(amount <= type(uint64).max, "Amount exceeds uint64");
        uint64 amount64 = uint64(amount);
        ISplToken.Seed[] memory seeds = new ISplToken.Seed[](0);
        (bool success, bytes memory result) = spl_token_address.delegatecall(
            abi.encodeWithSignature("transfer(bytes32,bytes32,uint64,(bytes)[])", from, to, amount64, seeds)
        );
        require(success, string(Convert.revert_msg(result)));
        return true;
    }

    /// @dev Read allowance from on-chain SPL token account delegate state
    /// @param account The SPL token account (ATA) to check
    /// @param delegate The pubkey (PDA) that may be set as delegate
    function allowance(bytes32 account, bytes32 delegate)
    internal
    view
    returns (uint256)
    {
        ISplToken.Account memory acc = SplToken.account_state(account);
        if (acc.delegate == delegate) {
            return uint256(acc.delegated_amount);
        }
        return 0;
    }

    /// @dev Approve a delegate on the caller's SPL token account via CPI to SPL Token program
    /// @param sourceAta The caller's ATA (source token account)
    /// @param delegate The delegate's pubkey (PDA) to approve
    /// @param value The amount to approve (must fit in uint64)
    function approve(bytes32 sourceAta, bytes32 delegate, uint256 value)
    internal
    returns (bool)
    {
        require(value <= type(uint64).max, "Amount exceeds uint64");
        bytes32 ownerPda = RomeEVMAccount.pda(msg.sender);

        // SPL Token Approve instruction: discriminator 4 (u8) + amount (u64 LE)
        bytes memory ixData = abi.encodePacked(
            uint8(4),
            Convert.u64le(uint64(value))
        );

        ICrossProgramInvocation.AccountMeta[] memory meta = new ICrossProgramInvocation.AccountMeta[](3);
        meta[0] = ICrossProgramInvocation.AccountMeta(sourceAta, false, true);   // source ATA (writable)
        meta[1] = ICrossProgramInvocation.AccountMeta(delegate, false, false);    // delegate
        meta[2] = ICrossProgramInvocation.AccountMeta(ownerPda, true, false);     // owner (signer)

        (bool success, bytes memory result) = cpi_program_address.delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                SPL_TOKEN_PROGRAM,
                meta,
                ixData
            )
        );
        require(success, string(Convert.revert_msg(result)));
        return true;
    }

    /// @dev Kept for backwards-compat signature; delegates to 3-arg version.
    ///      Should not be called directly — use approve(sourceAta, delegate, value).
    function approve(bytes32 spender, uint256 value)
    internal
    returns (bool)
    {
        revert("approve: use approve(sourceAta, delegate, value)");
    }

    /// @dev Transfer tokens from `from` ATA to `to` ATA using delegate authority.
    ///      The caller (msg.sender) must have been approved as delegate on `from`.
    function transferFrom(bytes32 from, bytes32 to, uint256 value)
    internal
    returns (bool)
    {
        require(value <= type(uint64).max, "Amount exceeds uint64");
        bytes32 delegatePda = RomeEVMAccount.pda(msg.sender);

        // SPL Token Transfer instruction: discriminator 3 (u8) + amount (u64 LE)
        bytes memory ixData = abi.encodePacked(
            uint8(3),
            Convert.u64le(uint64(value))
        );

        ICrossProgramInvocation.AccountMeta[] memory meta = new ICrossProgramInvocation.AccountMeta[](3);
        meta[0] = ICrossProgramInvocation.AccountMeta(from, false, true);         // source ATA (writable)
        meta[1] = ICrossProgramInvocation.AccountMeta(to, false, true);           // dest ATA (writable)
        meta[2] = ICrossProgramInvocation.AccountMeta(delegatePda, true, false);  // delegate authority (signer)

        (bool success, bytes memory result) = cpi_program_address.delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                SPL_TOKEN_PROGRAM,
                meta,
                ixData
            )
        );
        require(success, string(Convert.revert_msg(result)));
        return true;
    }
}
