// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";

contract cu_example {
    bytes32 public constant SYSTEM_PROGRAM_ID = 0x0000000000000000000000000000000000000000000000000000000000000000;
    
    function create_payer_account1() external {

        bytes32 rome_program = SystemProgram.rome_evm_program_id();
        bytes32 from = SystemProgram.operator();
        bytes memory salt = bytes("PAYER");

        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(bytes("EXTERNAL_AUTHORITY"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(msg.sender));
        seeds[2] = ISystemProgram.Seed(salt);

        (bytes32 to,) = SystemProgram.find_program_address(rome_program, seeds);

        ICrossProgramInvocation.AccountMeta[] memory meta = new ICrossProgramInvocation.AccountMeta[](2);
        meta[0] = ICrossProgramInvocation.AccountMeta(from, true, true);
        meta[1] = ICrossProgramInvocation.AccountMeta(to, false, true);

        bytes memory byte_1 = new bytes(4);
        byte_1[0] = bytes1(uint8(2));

        bytes memory byte_2 = new bytes(8);
        for (uint i = 0; i < 8; i++) {
            byte_2[i] = bytes1(uint8(1000000000 >> (8 * i)));
        }

        bytes memory data =abi.encodePacked(
            byte_1,
            byte_2
        );
            
        (bool success, ) = address(CpiProgram).delegatecall(
         abi.encodeWithSignature("invoke(bytes32,(bytes32,bool,bool)[],bytes)", SYSTEM_PROGRAM_ID, meta, abi.encodePacked(data))
        );
        require (success, "revert");    }
}

