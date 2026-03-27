// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ICrossProgramInvocation as icpi, CpiProgram as cpi} from "../interface.sol";
import {SystemProgramInstructionData as Ix} from  "./instruction_data.sol";
import "../convert.sol";

library SystemProgramLib {
    bytes32 public constant PROGRAM_ID = 0x0000000000000000000000000000000000000000000000000000000000000000;

    function transfer(bytes32 from, bytes32 to, uint64 lamports) external {
        icpi.AccountMeta[] memory meta = new icpi.AccountMeta[](2);
        meta[0] = icpi.AccountMeta(from, true, true);
        meta[1] = icpi.AccountMeta(to, false, true);

        bytes memory data = Ix.transfer(lamports);

            
        (bool success, bytes memory result) = address(cpi).delegatecall(
         abi.encodeWithSignature("invoke(bytes32,(bytes32,bool,bool)[],bytes)", PROGRAM_ID, meta, abi.encodePacked(data))
        );
        require (success, string(Convert.revert_msg(result)));
    }
}
