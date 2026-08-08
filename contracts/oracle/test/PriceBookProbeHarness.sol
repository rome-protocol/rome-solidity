// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PriceBookProbe.sol";

/// @title PriceBookProbeHarness
/// @notice Test double for PriceBookProbe: replaces the account-read precompile
///         with settable per-account bytes so the write-path semantics can be
///         exercised on the simulated network. Empty (unset) data trips the
///         parser's length guard — the missing-account fault path.
contract PriceBookProbeHarness is PriceBookProbe {
    mapping(bytes32 => bytes) private _data;

    function setAccountData(bytes32 acct, bytes calldata data) external {
        _data[acct] = data;
    }

    function _fetchAccount(bytes32 acct) internal view override returns (bytes memory) {
        return _data[acct];
    }
}
