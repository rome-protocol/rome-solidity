// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../PriceBook.sol";

/// @title PriceBookHarness
/// @notice Test double for PriceBook: the three account reads (full fetch,
///         publish_time peek, owner lookup) are backed by settable state —
///         the precompiles are unavailable on the simulated network. The peek
///         is settable INDEPENDENTLY of the full bytes so tests can observe
///         the cheap-skip short-circuit (peek says not-newer while the full
///         data would commit).
contract PriceBookHarness is PriceBook {
    mapping(bytes32 => bytes) private _data;
    mapping(bytes32 => uint64) private _peek;
    mapping(bytes32 => bytes32) private _owners;

    constructor(bytes32 receiverId, address adapterImpl) PriceBook(receiverId, adapterImpl) {}

    function setAccountData(bytes32 acct, bytes calldata data) external {
        _data[acct] = data;
    }

    function setPeekValue(bytes32 acct, uint64 publishTime) external {
        _peek[acct] = publishTime;
    }

    function setAccountOwner(bytes32 acct, bytes32 accountOwner) external {
        _owners[acct] = accountOwner;
    }

    /// @notice Rewind the stored publishTime by `delta` seconds so tests can
    ///         age an entry past the cheap-skip bypass threshold.
    function setEntryAgeForTest(bytes32 acct, uint256 delta) external {
        uint256 packed = _entries[acct];
        uint64 pt = uint64(packed >> 64);
        uint64 aged = pt - uint64(delta);
        _entries[acct] = (packed & ~(uint256(type(uint64).max) << 64)) | (uint256(aged) << 64);
    }

    function _fetchRaw(bytes32 acct) internal view override returns (bool ok, bytes memory data) {
        data = _data[acct];
        ok = data.length > 0;
    }

    function _peekPublishTime(bytes32 acct) internal view override returns (bool ok, uint64 publishTime) {
        if (_peek[acct] != 0) return (true, _peek[acct]);
        bytes memory d = _data[acct];
        if (d.length < 101) return (false, 0);
        uint64 v;
        for (uint256 i = 0; i < 8; i++) {
            v |= uint64(uint8(d[93 + i])) << uint64(8 * i);
        }
        return (true, v);
    }

    function _accountOwner(bytes32 acct) internal view override returns (bytes32) {
        bytes32 o = _owners[acct];
        return o == bytes32(0) ? pythReceiverProgramId : o;
    }
}

/// @title BookFeedAdapterHarness
/// @notice Unlocks the implementation's initialize so equivalence tests can
///         exercise an adapter over a never-registered account (the
///         `UninitializedPriceFeed` leg — unreachable through registerFeed,
///         which always ends in a committed first refresh).
contract BookFeedAdapterHarness is BookFeedAdapter {
    constructor() BookFeedAdapter() {
        initialized = false;
    }
}
