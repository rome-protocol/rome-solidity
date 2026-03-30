// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interface.sol";
import "./convert.sol";
import "./system_program/system_program.sol";

library RomeEVMAccount {
    function authority_seeds(address user) internal pure returns(ISystemProgram.Seed[] memory) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(bytes("EXTERNAL_AUTHORITY"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(user));

        return seeds;
    }

    function authority_seeds_with_salt(address user, bytes32 salt) internal pure returns(ISystemProgram.Seed[] memory) {
        bytes memory salt_ = Convert.bytes32_to_bytes(salt);

        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(bytes("EXTERNAL_AUTHORITY"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(user));
        seeds[2] = ISystemProgram.Seed(salt_);

        return seeds;
    }

    function minimum_balance(uint64 len) internal pure returns(uint64) {
        // (ACCOUNT_STORAGE_OVERHEAD + len) * LAMPORTS_PER_BYTE_YEAR * EXEMPTION_THRESHOLD
        return (128 + len) * 3480 * 2;
    }

    function pda_with_salt(address user, bytes32 salt) internal view returns (bytes32) {
        bytes32 rome_program = SystemProgram.rome_evm_program_id();
        ISystemProgram.Seed[] memory seeds = RomeEVMAccount.authority_seeds_with_salt(user, salt);
        (bytes32 key,) = SystemProgram.find_program_address(rome_program, seeds);
        return key;
    }

    function get_payer(address user, bytes32 salt) internal view returns (bytes32) {
        return pda_with_salt(user, salt);
    }

    function create_payer(address user, uint64 lamports, bytes32 salt)  external {
        bytes32 key = get_payer(user, salt);

        (uint64 lamports_,,,,,) = CpiProgram.account_info(key);
        if (lamports_ == 0) {
            require(lamports >= minimum_balance(0), "insufficient lamports, rent-exemption value is 890880");
        }

        SystemProgramLib.transfer(SystemProgram.operator(), key, lamports);
    }
}