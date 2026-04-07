// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../convert.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";


library AssociatedSplToken {
    function create_associated_token_account(
        bytes32 funding_address,
        bytes32 wallet_address,
        bytes32 token_mint_address,
        bytes32 system_program_id,
        bytes32 token_program_id,
        bytes32 associated_token_program_id
    ) internal pure returns(bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory, bytes32) {
        return _create_associated_token_account(
            funding_address,
            wallet_address,
            token_mint_address,
            0, // AssociatedTokenAccountInstruction::Create
            system_program_id,
            token_program_id,
            associated_token_program_id
        );
    }

    function create_associated_token_account_idempotent(
        bytes32 funding_address,
        bytes32 wallet_address,
        bytes32 token_mint_address,
        bytes32 system_program_id,
        bytes32 token_program_id,
        bytes32 associated_token_program_id
    ) internal pure returns(bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory, bytes32) {
        return _create_associated_token_account(
            funding_address,
            wallet_address,
            token_mint_address,
            1, // AssociatedTokenAccountInstruction::CreateIdempotent
            system_program_id,
            token_program_id,
            associated_token_program_id
        );
    }

    function recover_nested(
        bytes32 wallet_address,
        bytes32 owner_token_mint_address,
        bytes32 nested_token_mint_address,
        bytes32 token_program_id,
        bytes32 associated_token_program_id
    ) internal pure returns(bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory) {
        bytes32 owner_associated_account_address =
            get_associated_token_address_with_program_id(
                wallet_address,
                owner_token_mint_address,
                token_program_id,
                associated_token_program_id
            );

        bytes32 destination_associated_account_address =
            get_associated_token_address_with_program_id(
                wallet_address,
                nested_token_mint_address,
                token_program_id,
                associated_token_program_id
            );

        bytes32 nested_associated_account_address =
            get_associated_token_address_with_program_id(
                owner_associated_account_address, // ATA is wrongly used as a wallet_address
                nested_token_mint_address,
                token_program_id,
                associated_token_program_id
            );

        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](7);

        accounts[0] = ICrossProgramInvocation.AccountMeta({
            pubkey: nested_associated_account_address,
            is_signer: false,
            is_writable: true
        });
        accounts[1] = ICrossProgramInvocation.AccountMeta({
            pubkey: nested_token_mint_address,
            is_signer: false,
            is_writable: false
        });
        accounts[2] = ICrossProgramInvocation.AccountMeta({
            pubkey: destination_associated_account_address,
            is_signer: false,
            is_writable: true
        });
        accounts[3] = ICrossProgramInvocation.AccountMeta({
            pubkey: owner_associated_account_address,
            is_signer: false,
            is_writable: false
        });
        accounts[4] = ICrossProgramInvocation.AccountMeta({
            pubkey: owner_token_mint_address,
            is_signer: false,
            is_writable: false
        });
        accounts[5] = ICrossProgramInvocation.AccountMeta({
            pubkey: wallet_address,
            is_signer: true,
            is_writable: true
        });
        accounts[6] = ICrossProgramInvocation.AccountMeta({
            pubkey: token_program_id,
            is_signer: false,
            is_writable: false
        });

        return (
            associated_token_program_id, 
            accounts, 
            abi.encodePacked(uint8(2)) // AssociatedTokenAccountInstruction::RecoverNested);
        );
    }

    /**
     * Prepares instruction data and accounts for creating an associated token account. 
     * @param funding_address EVM payer account (must contain enough SOL to pay for account creation)
     * @param wallet_address Address of the owner of the associated token account (usually a PDA derived from the user's EVM address)
     * @param token_mint_address Address of the SPL token mint for which the associated account is being created
     * @param instruction Creation instruction
     * @param system_program_id Solana System Program ID
     * @param token_program_id Solana Token Program ID
     * @param associated_token_program_id Solana Associated Token Program ID
     * @return associated_token_program_id The program ID to invoke (Associated Token Program)
     * @return accounts The list of accounts required for the instruction
     * @return data The instruction data (encoded instruction type)
     * @return associated_account_address The address of the associated token account that will be created
     */
    function _create_associated_token_account(
        bytes32 funding_address, // EVM payer (seed PAYER)
        bytes32 wallet_address,  // SPL token account owner RomeEVMAccount.pda(user)
        bytes32 token_mint_address,
        uint8 instruction,
        bytes32 system_program_id,
        bytes32 token_program_id,
        bytes32 associated_token_program_id
    ) internal pure returns(bytes32, ICrossProgramInvocation.AccountMeta[] memory, bytes memory, bytes32) {
        require(instruction <= 1, "invalid creation instruction");

        bytes32 associated_account_address =
            get_associated_token_address_with_program_id(
                wallet_address,
                token_mint_address,
                token_program_id,
                associated_token_program_id
            );

        ICrossProgramInvocation.AccountMeta[] memory accounts =
            new ICrossProgramInvocation.AccountMeta[](6);

        accounts[0] = ICrossProgramInvocation.AccountMeta({
            pubkey: funding_address,
            is_signer: true,
            is_writable: true
        });
        accounts[1] = ICrossProgramInvocation.AccountMeta({
            pubkey: associated_account_address,
            is_signer: false,
            is_writable: true
        });
        accounts[2] = ICrossProgramInvocation.AccountMeta({
            pubkey: wallet_address,
            is_signer: false,
            is_writable: false
        });
        accounts[3] = ICrossProgramInvocation.AccountMeta({
            pubkey: token_mint_address,
            is_signer: false,
            is_writable: false
        });
        accounts[4] = ICrossProgramInvocation.AccountMeta({
            pubkey: system_program_id,
            is_signer: false,
            is_writable: false
        });
        accounts[5] = ICrossProgramInvocation.AccountMeta({
            pubkey: token_program_id,
            is_signer: false,
            is_writable: false
        });

        return (
            associated_token_program_id,
            accounts,
            abi.encodePacked(instruction),
            associated_account_address
        );
    }

    function get_associated_token_address_with_program_id(
        bytes32 wallet_address,
        bytes32 token_mint_address,
        bytes32 token_program_id,
        bytes32 associated_token_program_id
    ) internal pure returns (bytes32) {
        (bytes32 addr, ) = get_associated_token_address_and_bump_seed(
            wallet_address,
            token_mint_address,
            token_program_id,
            associated_token_program_id
        );
        return addr;
    }

    function get_associated_token_address_and_bump_seed(
        bytes32 wallet_address,
        bytes32 token_mint_address,
        bytes32 token_program_id,
        bytes32 associated_token_program_id
    ) internal pure returns (bytes32, uint8) {
        return get_associated_token_address_and_bump_seed_internal(
            wallet_address,
            token_mint_address,
            token_program_id,
            associated_token_program_id
        );
    }

    function get_associated_token_address_and_bump_seed_internal(
        bytes32 wallet_address,
        bytes32 token_mint_address,
        bytes32 token_program_id,
        bytes32 associated_token_program_id
    ) internal pure returns (bytes32, uint8) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);

        seeds[0] = ISystemProgram.Seed({
            item: Convert.bytes32_to_bytes(wallet_address)
        });
        seeds[1] = ISystemProgram.Seed({
            item: Convert.bytes32_to_bytes(token_program_id)
        });
        seeds[2] = ISystemProgram.Seed({
            item: Convert.bytes32_to_bytes(token_mint_address)
        });

        return SystemProgram.find_program_address(associated_token_program_id, seeds);
    }
}







