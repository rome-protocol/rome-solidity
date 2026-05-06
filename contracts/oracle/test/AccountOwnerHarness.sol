// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../PythPullAdapter.sol";
import "../SwitchboardV3Adapter.sol";

/// @title PythAccountOwnerHarness
/// @notice Inherits PythPullAdapter and overrides `_fetchAccount` so tests
///         can exercise the parser path without the CPI precompile
///         (unavailable on hardhat's simulated network).
/// @dev    The historical M-5 per-read owner-revalidation has been retired
///         (see PythPullAdapter._fetchAccount comment). The harness keeps
///         the (account, owner, data) setter signature for back-compat with
///         existing tests; the `owner` argument is accepted but not used.
contract PythAccountOwnerHarness is PythPullAdapter {
    bytes32 private _mockAccount;
    bytes private _mockData;

    /// @dev Reset `initialized` after the parent constructor so this contract
    ///      can be initialized directly in tests (same pattern as the
    ///      staleness/confidence harnesses).
    constructor() PythPullAdapter() {
        initialized = false;
    }

    /// @notice Set the mocked CPI response for a given pubkey. The `owner`
    ///         arg is ignored — kept in the signature for back-compat with
    ///         pre-PR6 tests.
    function setMockAccount(bytes32 account, bytes32 /* owner */, bytes calldata data) external {
        _mockAccount = account;
        _mockData = data;
    }

    /// @dev Returns the most recently configured data slice for the adapter's
    ///      pythAccount. If the mock account pubkey doesn't match, returns
    ///      empty bytes — production parser will revert with PythPullDataTooShort.
    function _fetchAccount() internal view override returns (bytes memory data) {
        if (_mockAccount == pythAccount) {
            return _mockData;
        }
        return "";
    }

    function readAndParseExt() external view returns (
        int64 price,
        uint64 conf,
        int32 expo,
        uint64 publishTime,
        int64 emaPrice,
        uint64 emaConf
    ) {
        PythPullParser.PythPullPrice memory p = _readAndParse();
        return (p.price, p.conf, p.expo, p.publishTime, p.emaPrice, p.emaConf);
    }
}

/// @title SwitchboardAccountOwnerHarness
/// @notice Same as PythAccountOwnerHarness but for SwitchboardV3Adapter.
/// @dev    Per-read M-5 owner check retired; `owner` arg in setter ignored.
contract SwitchboardAccountOwnerHarness is SwitchboardV3Adapter {
    bytes32 private _mockAccount;
    bytes private _mockData;

    constructor() SwitchboardV3Adapter() {
        initialized = false;
    }

    function setMockAccount(bytes32 account, bytes32 /* owner */, bytes calldata data) external {
        _mockAccount = account;
        _mockData = data;
    }

    function _fetchAccount() internal view override returns (bytes memory data) {
        if (_mockAccount == switchboardAccount) {
            return _mockData;
        }
        return "";
    }

    function readAndParseExt() external view returns (
        int128 mantissa,
        uint32 scale,
        int64 timestamp,
        uint64 slot
    ) {
        SwitchboardParser.SwitchboardPrice memory p = _readAndParse();
        return (p.mantissa, p.scale, p.timestamp, p.slot);
    }
}
