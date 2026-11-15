// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interface.sol";
import "./convert.sol";
import "./system_program/system_program.sol";

library RomeEVMAccount {
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

    /// @notice The EXTERNAL_AUTHORITY PDA of `user`, via HelperProgram.
    function pda(address user) internal view returns (bytes32) {
        return HelperProgram.pda(user);
    }

    /// @notice The EXTERNAL_AUTHORITY PDA of `user` with `salt`, via HelperProgram.
    function pda_with_salt(address user, bytes32 salt) internal view returns (bytes32) {
        return HelperProgram.pda_with_salt(user, salt);
    }

    function get_payer(address user) internal view returns (bytes32) {
        return pda(user);
    }

    function create_payer(address user, uint64 lamports) internal {
        bytes32 key = get_payer(user);

        uint64 current_lamports = CpiProgram.account_lamports(key);
        if (current_lamports == 0) {
            require(lamports >= minimum_balance(0), "insufficient lamports, rent-exemption value is 890880");
        }

        if (current_lamports >= lamports) {
            return;
        }

        SystemProgramLib.Instruction memory ix =
                            SystemProgramLib.transfer(SystemProgram.operator(), key, lamports);

        (bool success, bytes memory result) = address(cpi_program_address).delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                ix.program_id, ix.accounts, ix.data
            )
        );

        require (success, string(Convert.revert_msg(result)));
    }
}