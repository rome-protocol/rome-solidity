// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RomeEvents} from "../RomeEvents.sol";

/// @title EventEmitter — minimal test contract for Hardhat integration tests.
/// @notice Calls RomeEvents.emitEvent (writes to ring PDA via precompile) and also
///         emits a native Solidity event so both the PDA and standard LOG are verifiable.
contract EventEmitter {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function fireTransfer(address to, uint256 value) external {
        bytes32 sig = keccak256("Transfer(address,address,uint256)");
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = bytes32(uint256(uint160(msg.sender)));
        topics[1] = bytes32(uint256(uint160(to)));
        RomeEvents.emitEvent(sig, topics, abi.encode(value));

        // Native Solidity event — preserved alongside the PDA write.
        emit Transfer(msg.sender, to, value);
    }
}
