// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICrossProgramInvocation} from "../../interface.sol";
import {AccountMetaBuilder} from "../AccountMetaBuilder.sol";

/// @dev Test-only wrapper exposing the AccountMetaBuilder library's fluent
///      API to external callers for golden-vector tests. Each public method
///      constructs a fresh Meta, runs a scripted sequence, returns the
///      resulting `AccountMeta[]`.
contract AccountMetaBuilderWrapper {
    function emptyBuild(uint256 size)
        external
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory)
    {
        AccountMetaBuilder.Meta memory m = AccountMetaBuilder.alloc(size);
        return AccountMetaBuilder.build(m);
    }

    function signerThenWritableThenReadonly(
        bytes32 signerKey,
        bytes32 writableKey,
        bytes32 readonlyKey
    ) external pure returns (ICrossProgramInvocation.AccountMeta[] memory) {
        AccountMetaBuilder.Meta memory m = AccountMetaBuilder.alloc(3);
        AccountMetaBuilder.signer(m, signerKey);
        AccountMetaBuilder.writable(m, writableKey);
        AccountMetaBuilder.readonly(m, readonlyKey);
        return AccountMetaBuilder.build(m);
    }

    function signerWritableOnly(bytes32 key)
        external
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory)
    {
        AccountMetaBuilder.Meta memory m = AccountMetaBuilder.alloc(1);
        AccountMetaBuilder.signerWritable(m, key);
        return AccountMetaBuilder.build(m);
    }

    /// Intentionally tries to push n+1 into alloc(n). Should revert.
    function overrun(uint256 n, bytes32 seedKey) external pure {
        AccountMetaBuilder.Meta memory m = AccountMetaBuilder.alloc(n);
        for (uint256 i = 0; i <= n; i++) {
            AccountMetaBuilder.readonly(m, seedKey);
        }
    }

    /// Underfill — alloc(3), push 2, call build(). Returns length-2 array
    /// (matches documented behaviour for conditional-append patterns).
    function underfillBuild(bytes32 a, bytes32 b)
        external
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory)
    {
        AccountMetaBuilder.Meta memory m = AccountMetaBuilder.alloc(3);
        AccountMetaBuilder.signer(m, a);
        AccountMetaBuilder.writable(m, b);
        return AccountMetaBuilder.build(m);
    }

    /// Underfill — alloc(3), push 2, call buildChecked(). Should revert.
    function underfillBuildChecked(bytes32 a, bytes32 b)
        external
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory)
    {
        AccountMetaBuilder.Meta memory m = AccountMetaBuilder.alloc(3);
        AccountMetaBuilder.signer(m, a);
        AccountMetaBuilder.writable(m, b);
        return AccountMetaBuilder.buildChecked(m);
    }
}
