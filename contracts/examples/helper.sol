// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";

contract helper_example {

    function create_ata () external {
        (bool success, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("create_ata(address)", msg.sender)
        );
        require (success, "revert");  
    }
    function create_ata_with_mint () external {
        bytes32 mint = SystemProgram.mint_id();
        address user = 0xe235b9caf55b58863Ae955A372e49362b0f93726;
        (bool success, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("create_ata(address,bytes32)", user, mint)
        );
        require (success, "revert");  
    }

    function create_pda () external {
        (bool success, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("create_pda(address)", msg.sender)
        );
        require (success, "revert");  
    }

    function create_pda_with_lamports () external {
        address user = 0xe235b9caf55b58863Ae955A372e49362b0f93726;

        (bool success, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("create_pda(address,uint64)", user, 1000000000)
        );
        require (success, "revert");  
    }

    function swap_gas_to_lamports() external {
        (bool success, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("swap_gas_to_lamports(uint64)", 1000000000)
        );
        require(success, "revert");
    }
    function transfer_lamports() external {
        address user = 0xe235b9caf55b58863Ae955A372e49362b0f93726;

        (bool success, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("transfer_lamports(address,uint64)", user, 1000000000)
        );
        require(success, "revert");
    }
    function transfer_spl() external {
        address user = 0xe235b9caf55b58863Ae955A372e49362b0f93726;

        (bool success, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("transfer_spl(address,uint64)", user, 1000000)
        );
        require(success, "revert");
    }
    function transfer_spl_with_mint() external {
        address user = 0xe235b9caf55b58863Ae955A372e49362b0f93726;
        bytes32 mint = SystemProgram.mint_id();

        (bool success, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("transfer_spl(address,uint64,bytes32)", user, 1000000, mint)
        );
        require(success, "revert");
    }
    function ata() external view returns(bytes32) {
        bytes32 mint = SystemProgram.mint_id();
        bytes32 ata_ = HelperProgram.ata(msg.sender, mint);
        return ata_; 
    }
    function pda() external view returns(bytes32) {
        bytes32 pda_ = HelperProgram.pda(msg.sender);
        return pda_; 
    }
    function deposit_from_ata() external {
        (bool success, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("deposit_from_ata(uint256)", 1 ether)
        );
        require(success, "revert");
    }
    function withdraw_to_ata() external {
        (bool success, ) = address(Withdraw).delegatecall(
            abi.encodeWithSignature("withdraw_to_ata(uint256)", 1 ether)
        );
        require(success, "revert");
    }
    function transfer_spl_to_signer() external {
        bytes32 mint = SystemProgram.mint_id();
        (bool success, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("transfer_spl_to_signer(uint64,bytes32)", 1000000, mint)
        );
        require(success, "revert");
    }
}