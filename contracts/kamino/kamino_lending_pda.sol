// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "../convert.sol";
import "./kamino_lending_lib.sol";

/// @title KaminoLendingPDA
/// @notice PDA derivation helpers for Kamino Lending accounts.
library KaminoLendingPDA {
    /// @notice Derive the obligation PDA for a given lending market and owner
    /// @param lending_market Lending market pubkey
    /// @param owner Owner pubkey (typically the Rome-EVM user PDA)
    /// @return key The derived obligation PDA
    function obligation_pda(bytes32 lending_market, bytes32 owner) internal view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(bytes("obligation"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(lending_market));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(owner));
        (bytes32 key,) = SystemProgram.find_program_address(KaminoLendingLib.PROGRAM_ID, seeds);
        return key;
    }

    /// @notice Derive the lending market authority PDA
    /// @param lending_market Lending market pubkey
    /// @return key The derived authority PDA
    function lending_market_authority(bytes32 lending_market) internal view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(bytes("lma"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(lending_market));
        (bytes32 key,) = SystemProgram.find_program_address(KaminoLendingLib.PROGRAM_ID, seeds);
        return key;
    }
}
