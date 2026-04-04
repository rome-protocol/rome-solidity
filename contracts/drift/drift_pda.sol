// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../convert.sol";

library DriftPDA {
    bytes32 public constant PROGRAM_ID = 0x0954dbbe9ec960c98a7a293fe21336966fe180d151ae4b8179561f89854a53f6;

    function state_pda() internal view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](1);
        seeds[0] = ISystemProgram.Seed(bytes("drift_state"));
        (bytes32 key,) = SystemProgram.find_program_address(PROGRAM_ID, seeds);
        return key;
    }

    function user_pda(bytes32 authority, uint16 sub_account_id) internal view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(bytes("user"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(authority));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(Convert.u16le(sub_account_id)));
        (bytes32 key,) = SystemProgram.find_program_address(PROGRAM_ID, seeds);
        return key;
    }

    function user_stats_pda(bytes32 authority) internal view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(bytes("user_stats"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(authority));
        (bytes32 key,) = SystemProgram.find_program_address(PROGRAM_ID, seeds);
        return key;
    }

    function perp_market_pda(uint16 market_index) internal view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(bytes("perp_market"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(Convert.u16le(market_index)));
        (bytes32 key,) = SystemProgram.find_program_address(PROGRAM_ID, seeds);
        return key;
    }

    function spot_market_pda(uint16 market_index) internal view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(bytes("spot_market"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(Convert.u16le(market_index)));
        (bytes32 key,) = SystemProgram.find_program_address(PROGRAM_ID, seeds);
        return key;
    }

    function spot_market_vault_pda(uint16 market_index) internal view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(bytes("spot_market_vault"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(Convert.u16le(market_index)));
        (bytes32 key,) = SystemProgram.find_program_address(PROGRAM_ID, seeds);
        return key;
    }

    function drift_signer() internal view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](1);
        seeds[0] = ISystemProgram.Seed(bytes("drift_signer"));
        (bytes32 key,) = SystemProgram.find_program_address(PROGRAM_ID, seeds);
        return key;
    }
}
