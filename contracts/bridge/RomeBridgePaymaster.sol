// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RomeBridgeEvents} from "./RomeBridgeEvents.sol";

contract RomeBridgePaymaster is ERC2771Forwarder, Ownable, RomeBridgeEvents {
    uint8 public constant SPONSORED_TX_CAP = 3;
    mapping(address => uint8) public sponsoredTxCount;

    mapping(address => mapping(bytes4 => bool)) public allowlist;

    error BudgetExhausted(address user);
    error TargetNotAllowed(address target, bytes4 selector);

    event AllowlistUpdated(address indexed target, bytes4 indexed selector, bool allowed);

    constructor(address admin)
        ERC2771Forwarder("RomeBridgePaymaster")
        Ownable(admin)
    {}

    function setAllowlistEntry(address target, bytes4 selector, bool allowed) external onlyOwner {
        allowlist[target][selector] = allowed;
        emit AllowlistUpdated(target, selector, allowed);
    }

    function _execute(
        ForwardRequestData calldata request,
        bool requireValidRequest
    ) internal virtual override returns (bool success) {
        bytes4 selector = _extractSelector(request.data);
        if (!allowlist[request.to][selector]) {
            revert TargetNotAllowed(request.to, selector);
        }

        address user = request.from;
        uint8 current = sponsoredTxCount[user];
        if (current >= SPONSORED_TX_CAP) {
            revert BudgetExhausted(user);
        }
        unchecked { sponsoredTxCount[user] = current + 1; }
        emit PaymasterSponsored(user, SPONSORED_TX_CAP - current - 1, request.to);
        success = super._execute(request, requireValidRequest);
    }

    function _extractSelector(bytes calldata data) private pure returns (bytes4) {
        if (data.length < 4) return bytes4(0);
        return bytes4(data[0:4]);
    }
}
