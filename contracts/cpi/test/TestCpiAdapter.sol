// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CpiAdapterBase} from "../templates/CpiAdapterBase.sol";

/// @dev Trivial concrete adapter extending CpiAdapterBase for template tests.
contract TestCpiAdapter is CpiAdapterBase {
    constructor(address owner_) CpiAdapterBase(owner_) {}

    /// Expose the internal helper.
    function u64check(uint256 value) external pure returns (uint64) {
        return _u64check(value);
    }

    /// A write-path placeholder that the pause test toggles.
    uint256 public writes;
    function doWrite() external whenNotPaused nonReentrant {
        writes += 1;
    }
}
