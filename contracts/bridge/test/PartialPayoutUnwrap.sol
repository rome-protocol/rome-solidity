// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title  PartialPayoutUnwrap
/// @notice Test-only stand-in for `HelperProgram.deposit_from_ata` that
///         credits only HALF of the requested amount to the caller. Lets
///         us verify RomeBridgeInbound's slippage check (A3) catches a
///         hypothetical precompile bug crediting less than expected.
contract PartialPayoutUnwrap {
    function deposit_from_ata(uint256 amount) external {
        uint256 half = amount / 2;
        (bool ok, ) = payable(msg.sender).call{value: half}("");
        require(ok, "partial deposit_from_ata forward failed");
    }

    receive() external payable {}
}
