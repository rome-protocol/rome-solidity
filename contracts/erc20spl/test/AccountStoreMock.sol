// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AccountStoreMock
/// @notice A Solana account store behind the CPI precompile's read selector, for tests of readers that
///         fetch accounts by address (the wrapper factory's metadata read). Unlike `MintInfoMock`, which is
///         stateless because it is installed with `hardhat_setCode`, this one is deployed normally and
///         handed to the factory as its `cpi_program`, so a test can plant any account it likes: an owner and
///         data for a pubkey, exactly as the chain would return them.
contract AccountStoreMock {
    struct Account {
        bool exists;
        bytes32 owner;
        bytes data;
    }

    mapping(bytes32 => Account) private accounts;

    function set(bytes32 pubkey, bytes32 owner, bytes calldata data) external {
        accounts[pubkey] = Account(true, owner, data);
    }

    function clear(bytes32 pubkey) external {
        delete accounts[pubkey];
    }

    /// @dev Same return shape as `ICrossProgramInvocation.account_info`: lamports, owner, is_signer,
    ///      is_writable, executable, data. A missing account has no lamports and no data.
    function account_info(bytes32 pubkey)
        external
        view
        returns (uint64, bytes32, bool, bool, bool, bytes memory)
    {
        Account storage a = accounts[pubkey];
        if (!a.exists) return (0, bytes32(0), false, false, false, "");
        return (1, a.owner, false, false, false, a.data);
    }
}
