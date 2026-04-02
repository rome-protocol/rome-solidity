// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../rome_evm_account.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {AssociatedSplTokenLib} from "../spl_token/associated_spl_token.sol";
import {Convert} from "../convert.sol";

/**
 * @dev Test helper for creating SPL mints and minting tokens in integration tests.
 *      Uses address(this) as the user for create_account to get a fresh PDA
 *      namespace per deployment (avoids collisions with deployer's existing PDA).
 *      NOT for production use.
 */
contract TestSPLMintHelper {
    bytes32[] public mints;
    bytes32 public lastMint;

    bytes32 constant SPL_TOKEN_PROGRAM =
        0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9;

    event MintCreated(bytes32 indexed mintAccount);
    event DebugStep(string step);
    event DebugBytes32(string label, bytes32 value);

    /// @notice Create a new SPL mint with the given decimals
    function createMint(uint8 _decimals, bytes32 salt) external {
        emit DebugStep("starting createMint");

        // Step 1: Create account using this contract's address as user
        // Each deployment gets a fresh PDA namespace
        emit DebugStep("calling create_account");
        bytes32 mintAccount = SystemProgram.create_account(
            SPL_TOKEN_PROGRAM,
            82, // SPL Mint account size
            address(this),
            salt
        );
        emit DebugBytes32("mintAccount", mintAccount);

        // Step 2: Initialize the mint via SPL Token precompile
        // Use the SPL Token precompile's initialize_account3 is for TOKEN ACCOUNTS not mints.
        // For mints, we need CPI to SPL Token's InitializeMint2 instruction.
        bytes32 callerPda = RomeEVMAccount.pda(msg.sender);

        // InitializeMint2: discriminator 20 | decimals | mint_authority (32 bytes) | no freeze
        bytes memory ixData = abi.encodePacked(
            uint8(20),
            _decimals,
            callerPda,
            uint8(0) // no freeze authority
        );

        ICrossProgramInvocation.AccountMeta[] memory meta = new ICrossProgramInvocation.AccountMeta[](1);
        meta[0] = ICrossProgramInvocation.AccountMeta(mintAccount, false, true);

        emit DebugStep("calling CPI invoke for InitializeMint2");

        // Use regular call — InitializeMint2 needs no signer
        CpiProgram.invoke(SPL_TOKEN_PROGRAM, meta, ixData);

        emit DebugStep("mint initialized");
        mints.push(mintAccount);
        lastMint = mintAccount;
        emit MintCreated(mintAccount);
    }

    /// @notice Mint tokens to a user's PDA ATA
    function mintTo(bytes32 mint, address user, uint64 amount) external {
        bytes32 userPda = RomeEVMAccount.pda(user);

        // Ensure ATA exists
        (bytes32 ata,) = AssociatedSplTokenLib.associated_token_address(userPda, mint);
        _ensureAta(userPda, mint, ata);

        // MintTo: discriminator 7 + amount (u64 LE)
        bytes memory ixData = abi.encodePacked(
            uint8(7),
            Convert.u64le(amount)
        );

        bytes32 mintAuthority = RomeEVMAccount.pda(msg.sender);

        ICrossProgramInvocation.AccountMeta[] memory meta = new ICrossProgramInvocation.AccountMeta[](3);
        meta[0] = ICrossProgramInvocation.AccountMeta(mint, false, true);
        meta[1] = ICrossProgramInvocation.AccountMeta(ata, false, true);
        meta[2] = ICrossProgramInvocation.AccountMeta(mintAuthority, true, false);

        // Use delegatecall so msg.sender's PDA signs as mint authority
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

    function ensureAta(bytes32 mint, address user) external {
        bytes32 userPda = RomeEVMAccount.pda(user);
        (bytes32 ata,) = AssociatedSplTokenLib.associated_token_address(userPda, mint);
        _ensureAta(userPda, mint, ata);
    }

    function mintAt(uint256 index) external view returns (bytes32) {
        return mints[index];
    }

    function _ensureAta(bytes32 owner, bytes32 mint, bytes32 ata) internal {
        (uint64 lamports,,,,,) = CpiProgram.account_info(ata);
        if (lamports == 0) {
            AssociatedSplTokenLib.create_associated_token_account(owner, mint);
        }
    }
}
