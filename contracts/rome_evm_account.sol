// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interface.sol";
import "./convert.sol";

library RomeEVMAccount {
    function balance_key_seeds(address user, uint chain_id) internal pure returns(ISystemProgram.Seed[] memory) {
        bytes memory chain_le = Convert.chain_id_le(chain_id);

        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(chain_le);
        seeds[1] = ISystemProgram.Seed(bytes("ACCOUN_SEED"));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(user));

        return seeds;
    }

    function pda(address user) internal view returns (bytes32) {
        bytes32 rome_program = SystemProgram.rome_evm_program_id();
        ISystemProgram.Seed[] memory pda_seeds = RomeEVMAccount.balance_key_seeds(user, block.chainid);
        (bytes32 key,) = SystemProgram.find_program_address(rome_program, pda_seeds);
        return key;
    }
}