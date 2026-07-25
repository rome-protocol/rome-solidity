// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DeliveredAmountHelper} from "./DeliveredAmountHelper.sol";

/// Test-only external surface over the pure library.
contract DeliveredAmountHelperHarness {
    function delivered(bool a, bool b, uint256 c, uint256 d, uint256 e) external pure returns (uint256) {
        return DeliveredAmountHelper.delivered(a, b, c, d, e);
    }
    function spl_fee(uint256 amount, uint16 bps, uint64 maximumFee) external pure returns (uint256) {
        return DeliveredAmountHelper.spl_fee(amount, bps, maximumFee);
    }
}
