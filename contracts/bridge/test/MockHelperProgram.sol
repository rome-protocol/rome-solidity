// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title  MockHelperProgram
/// @notice Hardhat-only stand-in for the Rome EVM `HelperProgram` precompile
///         at 0xff00000000000000000000000000000000000009. The real precompile
///         debits the caller's wrapper ATA and credits their Balance PDA via
///         CPI; on hardhatMainnet there is no CPI so this mock simulates the
///         "credit the caller's native balance" half by sending `amount` wei
///         from its own balance back to the caller.
///
///         Test setup funds the mock with enough ETH to cover the calls,
///         then copies this contract's runtime bytecode to the precompile
///         address via `hardhat_setCode` so RomeBridgeInbound's `HelperProgram`
///         constant resolves to it transparently.
contract MockHelperProgram {
    event MockDepositFromAtaCalled(address indexed caller, uint256 amount);

    function deposit_from_ata(uint256 amount) external {
        emit MockDepositFromAtaCalled(msg.sender, amount);
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "mock deposit_from_ata forward failed");
    }

    receive() external payable {}
}
