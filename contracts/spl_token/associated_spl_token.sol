// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../convert.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";


contract AssociatedSplToken {
    address public immutable cpi_contract_address;
    bytes32 public immutable system_program_id;
    bytes32 public immutable token_program_id;
    bytes32 public immutable associated_token_program_id;

    constructor(
        address _cpi_contract_address,
        bytes32 _system_program_id,
        bytes32 _token_program_id, 
        bytes32 _associated_token_program_id
    ) {
        cpi_contract_address = _cpi_contract_address;
        system_program_id = _system_program_id;
        token_program_id = _token_program_id;
        associated_token_program_id = _associated_token_program_id;
    }

    function create_associated_token_account(
        bytes32 funding_address,
        bytes32 wallet_address,
        bytes32 token_mint_address,
        bytes32[] memory seeds
    ) external {
        _create_associated_token_account(
            funding_address,
            wallet_address,
            token_mint_address,
            0, // AssociatedTokenAccountInstruction::Create
            seeds
        );
    }

    function create_associated_token_account_idempotent(
        bytes32 funding_address,
        bytes32 wallet_address,
        bytes32 token_mint_address,
        bytes32[] memory seeds
    ) external {
        _create_associated_token_account(
            funding_address,
            wallet_address,
            token_mint_address,
            1, // AssociatedTokenAccountInstruction::CreateIdempotent
            seeds
        );
    }

    function recover_nested(
        bytes32 wallet_address,
        bytes32 owner_token_mint_address,
        bytes32 nested_token_mint_address,
        bytes32[] memory seeds
    ) external {
        bytes32 owner_associated_account_address =
            get_associated_token_address_with_program_id(
                wallet_address,
                owner_token_mint_address
            );

        bytes32 destination_associated_account_address =
            get_associated_token_address_with_program_id(
                wallet_address,
                nested_token_mint_address
            );

        bytes32 nested_associated_account_address =
            get_associated_token_address_with_program_id(
                owner_associated_account_address, // ATA is wrongly used as a wallet_address
                nested_token_mint_address
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

        ICrossProgramInvocation(cpi_contract_address).invoke_signed(
            associated_token_program_id,
            accounts,
            abi.encodePacked(uint8(2)), // AssociatedTokenAccountInstruction::RecoverNested
            seeds
        );
    }

    function _create_associated_token_account(
        bytes32 funding_address, // EVM payer (seed PAYER)
        bytes32 wallet_address,  // SPL token account owner RomeEVMAccount.pda(user)
        bytes32 token_mint_address,
        uint8 instruction,
        bytes32[] memory seeds
    ) internal {
        require(instruction <= 1, "invalid creation instruction");

        bytes32 associated_account_address =
            get_associated_token_address_with_program_id(
                wallet_address,
                token_mint_address
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

        // delegatecall
        ICrossProgramInvocation(cpi_contract_address).invoke_signed(
            associated_token_program_id,
            accounts,
            abi.encodePacked(instruction),
            seeds
        );
    }

    function get_associated_token_address_with_program_id(
        bytes32 wallet_address,
        bytes32 token_mint_address
    ) internal view returns (bytes32) {
        (bytes32 addr, ) = get_associated_token_address_and_bump_seed(
            wallet_address,
            token_mint_address
        );
        return addr;
    }

    function get_associated_token_address_and_bump_seed(
        bytes32 wallet_address,
        bytes32 token_mint_address
    ) internal view returns (bytes32, uint8) {
        return get_associated_token_address_and_bump_seed_internal(
            wallet_address,
            token_mint_address
        );
    }

    function get_associated_token_address_and_bump_seed_internal(
        bytes32 wallet_address,
        bytes32 token_mint_address
    ) internal view returns (bytes32, uint8) {
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







