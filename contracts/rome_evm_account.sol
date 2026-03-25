// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interface.sol";
import "./convert.sol";
import "./system_program/system_program.sol";

library RomeEVMAccount {
    function authority_seeds(address user, uint chain_id) internal pure returns(ISystemProgram.Seed[] memory) {
        bytes memory chain_le = Convert.chain_id_le(chain_id);

        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(chain_le);
        seeds[1] = ISystemProgram.Seed(bytes("EXTERNAL_AUTHORITY"));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(user));

        return seeds;
    }

    function authority_seeds_with_salt(address user, uint chain_id, bytes32 salt) internal pure returns(ISystemProgram.Seed[] memory) {
        bytes memory chain_le = Convert.chain_id_le(chain_id);
        bytes memory salt_ = Convert.bytes32_to_bytes(salt);

        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](4);
        seeds[0] = ISystemProgram.Seed(chain_le);
        seeds[1] = ISystemProgram.Seed(bytes("EXTERNAL_AUTHORITY"));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(user));
        seeds[3] = ISystemProgram.Seed(salt_);

        return seeds;
    }

    function pda(address user) internal view returns (bytes32) {
        bytes32 rome_program = SystemProgram.rome_evm_program_id();
        ISystemProgram.Seed[] memory pda_seeds = RomeEVMAccount.authority_seeds(user, block.chainid);
        (bytes32 key,) = SystemProgram.find_program_address(rome_program, pda_seeds);
        return key;
    }

    function pda_with_salt(address user, bytes32 salt) internal view returns (bytes32) {
        bytes32 rome_program = SystemProgram.rome_evm_program_id();
        ISystemProgram.Seed[] memory pda_seeds = RomeEVMAccount.authority_seeds_with_salt(user, block.chainid, salt);
        (bytes32 key,) = SystemProgram.find_program_address(rome_program, pda_seeds);
        return key;
    }

    function create_payer(address user, uint64 lamports)  external {
        bytes32 salt = Convert.bytes_to_bytes32(bytes("PAYER"));
        bytes32 payer = RomeEVMAccount.pda_with_salt(user, salt);

        SystemProgramLib.transfer(SystemProgram.operator(), payer, lamports);
    }
}