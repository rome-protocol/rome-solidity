// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./PriceBookProbeFast.sol";

/// @title PriceBookProbeFastHarness
/// @notice Test double for PriceBookProbeFast: replaces both account-read
///         paths (raw fetch + publish_time peek) with settable per-account
///         bytes, plus a fetch-failure switch for the fault path. Both
///         overrides are required — the precompile address has no code on the
///         simulated network, and the no-code guard reverts in the caller.
contract PriceBookProbeFastHarness is PriceBookProbeFast {
    mapping(bytes32 => bytes) private _data;
    mapping(bytes32 => bool) private _fail;

    function setAccountData(bytes32 acct, bytes calldata data) external {
        _data[acct] = data;
    }

    function setFetchFail(bytes32 acct, bool fail) external {
        _fail[acct] = fail;
    }

    function _fetchRaw(bytes32 acct) internal view override returns (bool ok, bytes memory data) {
        if (_fail[acct]) return (false, "");
        return (true, _data[acct]);
    }

    function _peekPublishTime(bytes32 acct) internal view override returns (bool ok, uint64 publishTime) {
        bytes memory d = _data[acct];
        if (_fail[acct] || d.length < 101) return (false, 0);
        uint64 v;
        for (uint256 i = 0; i < 8; i++) {
            v |= uint64(uint8(d[93 + i])) << uint64(8 * i);
        }
        return (true, v);
    }
}
