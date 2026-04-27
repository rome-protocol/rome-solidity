// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";

contract MockBridgeTarget is ERC2771Context {
    address public lastCaller;

    constructor(address forwarder) ERC2771Context(forwarder) {}

    function touch() external {
        lastCaller = _msgSender();
    }

    function _contextSuffixLength() internal pure override returns (uint256) {
        return 20;
    }
}
