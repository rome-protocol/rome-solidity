// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20Users} from "./erc20spl.sol";
import {SPL_ERC20_Token2022Hooked} from "./erc20spl_token2022_hooked.sol";

/// @dev Keeps the hooked wrapper's creation code out of ERC20SPLFactory's
/// runtime bytecode. Only the factory that created this deployer may use it.
contract ERC20SPLHookedDeployer {
    address public immutable factory;

    error OnlyFactory(address caller);

    constructor() {
        factory = msg.sender;
    }

    function deploy(
        bytes32 mint,
        address cpiProgram,
        string memory name,
        string memory symbol,
        ERC20Users users
    ) external returns (address wrapper) {
        if (msg.sender != factory) revert OnlyFactory(msg.sender);
        wrapper = address(new SPL_ERC20_Token2022Hooked(
            mint, cpiProgram, name, symbol, users
        ));
    }
}
