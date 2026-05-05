// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import {CpiProgram, SystemProgram, UnwrapSplToGas, ISystemProgram, ICrossProgramInvocation} from "../interface.sol";
import {Convert} from "../convert.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {AssociatedSplToken} from "../spl_token/associated_spl_token.sol";
import {SystemProgramLib} from "../system_program/system_program.sol";

contract UnwrapSplToGasContract  {
    function unwrap_spl_to_gas(uint256 value)  external {
        (bool success, bytes memory result) = address(UnwrapSplToGas).delegatecall(
            abi.encodeWithSignature("unwrap_spl_to_gas(uint256)", value)
        );
        require (success, string(Convert.revert_msg(result)));
    }

    function rome_wallet_ata() public view returns(string memory) {
        bytes32 rome_program = SystemProgram.rome_evm_program_id();

        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(Convert.chain_id_le(block.chainid));
        seeds[1] = ISystemProgram.Seed(bytes("CONTRACT_SOL_WALLET"));

        (bytes32 wallet,) = SystemProgram.find_program_address(rome_program, seeds);

        bytes32 ata_b32 = ata(wallet);
        bytes memory ata_b58 = SystemProgram.bytes32_to_base58(bytes32(ata_b32));

        return string(ata_b58);
    }

    function user_ata() public view returns (string memory) {
        bytes32 user_pda = RomeEVMAccount.pda(msg.sender);
        bytes32 ata_b32 = ata(user_pda);
        bytes memory ata_b58 = SystemProgram.bytes32_to_base58(bytes32(ata_b32));

        return string(ata_b58);
    }

    function spl_balance(string memory token_account) public view returns (uint64) {
        bytes32 ata_b32 = SystemProgram.base58_to_bytes32(bytes(token_account));
        return SplTokenLib.load_token_amount(ata_b32, address(CpiProgram));
    }

    function ata(bytes32 pda) internal view returns(bytes32) {
        bytes32 mint_id = SystemProgram.mint_id();
        require(mint_id != bytes32(0), "Rollup doesn't use SPL as gas token");

        (,bytes32 spl_program,,,,) = CpiProgram.account_info(mint_id);

        bytes32 key = AssociatedSplToken.get_associated_token_address_with_program_id(
            pda,
            mint_id,
            spl_program,
            AssociatedSplToken.ASSOCIATED_TOKEN_PROGRAM_ID
        );

        return key;
    }

    function create_payer()  public {
        RomeEVMAccount.create_payer(msg.sender, 10000000);
    }

    function payer() internal view returns (bytes32) {
        bytes32 rome_program = SystemProgram.rome_evm_program_id();
        bytes32 salt = Convert.bytes_to_bytes32(bytes("PAYER"));
        ISystemProgram.Seed[] memory seeds = RomeEVMAccount.authority_seeds_with_salt(msg.sender, salt);
        (bytes32 key,) = SystemProgram.find_program_address(rome_program, seeds);
        return key;
    }

    function create_user_ata() external {
        bytes32 funding = payer();
        bytes32 wallet = RomeEVMAccount.pda(msg.sender);
        bytes32 token_mint = SystemProgram.mint_id();

        (
            bytes32 program_id,
            ICrossProgramInvocation.AccountMeta[] memory accounts,
            bytes memory data,
        ) = AssociatedSplToken.create_associated_token_account_idempotent(
            funding,
            wallet,
            token_mint,
            SystemProgramLib.PROGRAM_ID,
            SplTokenLib.SPL_TOKEN_PROGRAM,
            AssociatedSplToken.ASSOCIATED_TOKEN_PROGRAM_ID
        );

        bytes32[] memory seeds = new bytes32[](1);
        seeds[0] = Convert.bytes_to_bytes32(bytes("PAYER"));

        (bool success, bytes memory result) = address(CpiProgram).delegatecall(
            abi.encodeWithSelector(
                ICrossProgramInvocation.invoke_signed.selector,
                program_id,
                accounts,
                data,
                seeds
            )
        );

        require(success, string(result));
    }
}