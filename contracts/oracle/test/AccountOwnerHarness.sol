// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../PythPullAdapter.sol";
import "../SwitchboardV3Adapter.sol";

/// @title PythAccountOwnerHarness
/// @notice Inherits PythPullAdapter and overrides `_fetchAccount` so tests
///         can drive the owner-revalidation check (M-5) without the CPI
///         precompile (unavailable on hardhat's simulated network).
contract PythAccountOwnerHarness is PythPullAdapter {
    bytes32 private _mockAccount;
    bytes32 private _mockOwner;
    bytes private _mockData;

    /// @dev Reset `initialized` after the parent constructor so this contract
    ///      can be initialized directly in tests (same pattern as the
    ///      staleness/confidence harnesses).
    constructor() PythPullAdapter() {
        initialized = false;
    }

    /// @notice Set the mocked CPI response for a given pubkey. Tests call
    ///         this after initialize() to simulate the Solana account's
    ///         current state.
    function setMockAccount(bytes32 account, bytes32 owner, bytes calldata data) external {
        _mockAccount = account;
        _mockOwner = owner;
        _mockData = data;
    }

    /// @dev Returns the most recently configured owner/data for the adapter's
    ///      pythAccount. If the mock account pubkey doesn't match, returns
    ///      zero-owner/empty-data so the owner check reverts cleanly.
    function _fetchAccount() internal view override returns (bytes32 owner, bytes memory data) {
        if (_mockAccount == pythAccount) {
            return (_mockOwner, _mockData);
        }
        return (bytes32(0), "");
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
contract SwitchboardAccountOwnerHarness is SwitchboardV3Adapter {
    bytes32 private _mockAccount;
    bytes32 private _mockOwner;
    bytes private _mockData;

    constructor() SwitchboardV3Adapter() {
        initialized = false;
    }

    function setMockAccount(bytes32 account, bytes32 owner, bytes calldata data) external {
        _mockAccount = account;
        _mockOwner = owner;
        _mockData = data;
    }

    function _fetchAccount() internal view override returns (bytes32 owner, bytes memory data) {
        if (_mockAccount == switchboardAccount) {
            return (_mockOwner, _mockData);
        }
        return (bytes32(0), "");
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
