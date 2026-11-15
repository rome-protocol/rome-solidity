// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CpiProgram} from "../interface.sol";

/// @title AccountReader
/// @dev Typed reads over the CpiProgram account-read selectors; cross-state reads, no CPI and no signing.
library AccountReader {
    /// Lamports balance of `account`; 0 when the account does not exist.
    function lamportsOf(bytes32 account) internal view returns (uint64) {
        return CpiProgram.account_lamports(account);
    }

    /// Read a little-endian `uint64` at `offset` bytes into `account`'s
    /// data buffer. The most common SPL Token offset (e.g. Mint.supply
    /// at offset 36, TokenAccount.amount at offset 64, TokenAccount.
    /// delegated_amount at offset 121).
    function readU64At(bytes32 account, uint16 offset) internal view returns (uint64) {
        return CpiProgram.account_u64_at(account, offset);
    }

    /// Read `length` bytes starting at `offset` from `account`'s data
    /// buffer. Returns the raw slice. Caller parses (Borsh, COption,
    /// custom layout).
    function readBytesAt(bytes32 account, uint16 offset, uint16 length)
        internal
        view
        returns (bytes memory)
    {
        return CpiProgram.account_data_at(account, offset, length);
    }
}
