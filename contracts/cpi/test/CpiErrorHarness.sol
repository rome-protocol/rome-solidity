// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CpiError} from "../CpiError.sol";

/// @dev Test-only harness exposing the CpiError selectors + revert paths so
///      the ts-side can assert selector stability.
contract CpiErrorHarness {
    function selectorAmountTooLarge() external pure returns (bytes4) {
        return CpiError.AmountTooLarge.selector;
    }
    function selectorSignerMismatch() external pure returns (bytes4) {
        return CpiError.SignerMismatch.selector;
    }
    function selectorInvalidAccountCount() external pure returns (bytes4) {
        return CpiError.InvalidAccountCount.selector;
    }
    function selectorCpiUnauthorized() external pure returns (bytes4) {
        return CpiError.CpiUnauthorized.selector;
    }

    function revertAmountTooLarge(uint256 amount) external pure {
        revert CpiError.AmountTooLarge(amount);
    }
    function revertSignerMismatch(address expected, address actual) external pure {
        revert CpiError.SignerMismatch(expected, actual);
    }
    function revertInvalidAccountCount(uint256 got, uint256 want) external pure {
        revert CpiError.InvalidAccountCount(got, want);
    }
    function revertCpiUnauthorized() external pure {
        revert CpiError.CpiUnauthorized();
    }
}
