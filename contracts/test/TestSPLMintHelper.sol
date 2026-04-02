// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../rome_evm_account.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {AssociatedSplTokenLib} from "../spl_token/associated_spl_token.sol";
import {Convert} from "../convert.sol";

/**
 * @dev Test helper for creating SPL mints and minting tokens in integration tests.
 *      NOT for production use.
 */
contract TestSPLMintHelper {
    bytes32[] public mints;
    bytes32 public lastMint;

    bytes32 constant SPL_TOKEN_PROGRAM =
        0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9;

    /// @notice Create a new SPL mint with the given decimals
    function createMint(uint8 _decimals) external {
        // Create a mint account via System Program + SPL Token InitializeMint
        bytes32 ownerPda = RomeEVMAccount.pda(msg.sender);

        // Use a salt derived from mint count for unique account
        bytes32 salt = bytes32(mints.length);
        bytes32 mintAccount = SystemProgram.create_account(
            SPL_TOKEN_PROGRAM,
            82, // SPL Mint account size
            msg.sender,
            salt
        );

        // Initialize the mint via CPI to SPL Token program
        // InitializeMint2 instruction: discriminator 20 (u8) + decimals (u8) + mint_authority (32 bytes) + freeze_authority COption (1 + 32 bytes)
        bytes memory ixData = abi.encodePacked(
            uint8(20), // InitializeMint2
            _decimals,
            ownerPda, // mint authority
            uint8(0) // no freeze authority (COption::None)
        );

        ICrossProgramInvocation.AccountMeta[] memory meta = new ICrossProgramInvocation.AccountMeta[](1);
        meta[0] = ICrossProgramInvocation.AccountMeta(mintAccount, false, true);

        (bool success, bytes memory result) = cpi_program_address.delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                SPL_TOKEN_PROGRAM,
                meta,
                ixData
            )
        );
        require(success, string(Convert.revert_msg(result)));

        mints.push(mintAccount);
        lastMint = mintAccount;
    }

    /// @notice Mint tokens to a user's PDA ATA
    function mintTo(bytes32 mint, address user, uint64 amount) external {
        bytes32 userPda = RomeEVMAccount.pda(user);

        // Ensure ATA exists
        (bytes32 ata,) = AssociatedSplTokenLib.associated_token_address(userPda, mint);
        _ensureAta(userPda, mint, ata);

        // MintTo instruction: discriminator 7 (u8) + amount (u64 LE)
        bytes memory ixData = abi.encodePacked(
            uint8(7), // MintTo
            Convert.u64le(amount)
        );

        bytes32 mintAuthority = RomeEVMAccount.pda(msg.sender);

        ICrossProgramInvocation.AccountMeta[] memory meta = new ICrossProgramInvocation.AccountMeta[](3);
        meta[0] = ICrossProgramInvocation.AccountMeta(mint, false, true);        // mint (writable)
        meta[1] = ICrossProgramInvocation.AccountMeta(ata, false, true);          // destination ATA (writable)
        meta[2] = ICrossProgramInvocation.AccountMeta(mintAuthority, true, false); // mint authority (signer)

        (bool success, bytes memory result) = cpi_program_address.delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                SPL_TOKEN_PROGRAM,
                meta,
                ixData
            )
        );
        require(success, string(Convert.revert_msg(result)));
    }

    /// @notice Ensure an ATA exists for a user+mint combination
    function ensureAta(bytes32 mint, address user) external {
        bytes32 userPda = RomeEVMAccount.pda(user);
        (bytes32 ata,) = AssociatedSplTokenLib.associated_token_address(userPda, mint);
        _ensureAta(userPda, mint, ata);
    }

    /// @notice Get the mint at a given index
    function mintAt(uint256 index) external view returns (bytes32) {
        return mints[index];
    }

    function _ensureAta(bytes32 owner, bytes32 mint, bytes32 ata) internal {
        // Check if ATA exists by trying account_info
        (uint64 lamports,,,,,) = CpiProgram.account_info(ata);
        if (lamports == 0) {
            // ATA doesn't exist, create it
            AssociatedSplTokenLib.create_associated_token_account(owner, mint);
        }
    }
}
