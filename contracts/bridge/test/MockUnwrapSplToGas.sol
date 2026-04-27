// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title  MockUnwrapSplToGas
/// @notice Hardhat-only stand-in for the Rome EVM `unwrap_spl_to_gas` precompile
///         at 0x4200000000000000000000000000000000000017. The real precompile
///         debits the caller's wrapper ATA and credits their Balance PDA via
///         CPI; on hardhatMainnet there is no CPI so this mock simulates the
///         "credit the caller's native balance" half by sending `amount` wei
///         from its own balance back to the caller.
///
///         Test setup funds the mock with enough ETH to cover the unwrap calls,
///         then copies this contract's runtime bytecode to the precompile
///         address via `hardhat_setCode` so RomeBridgeInbound's `UnwrapSplToGas`
///         constant resolves to it transparently.
contract MockUnwrapSplToGas {
    event MockUnwrapCalled(address indexed caller, uint256 amount);

    function unwrap_spl_to_gas(uint256 amount) external {
        emit MockUnwrapCalled(msg.sender, amount);
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "mock unwrap forward failed");
    }

    receive() external payable {}
}
