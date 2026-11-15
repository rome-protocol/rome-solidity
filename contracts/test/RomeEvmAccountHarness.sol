// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RomeEVMAccount} from "../rome_evm_account.sol";

/// @notice Exposes `RomeEVMAccount.create_payer` for `tests/RomeEvmAccount.test.ts`.
contract RomeEvmAccountHarness {
    function createPayer(address user, uint64 lamports) external {
        RomeEVMAccount.create_payer(user, lamports);
    }
}

/// @notice Holds the PDA balance the mock reports and records the System transfers it is asked for.
contract CreatePayerLedger {
    uint64 public balance;
    uint256 public transfers;
    uint64 public lastTransfer;

    function setBalance(uint64 balance_) external {
        balance = balance_;
    }

    function recordTransfer(uint64 lamports) external {
        transfers += 1;
        lastTransfer = lamports;
    }
}

/// @notice Installed at the HELPER, SYSTEM and CPI precompile addresses; `invoke` is reached by `delegatecall`,
///         so it records through a plain call into the ledger.
contract CreatePayerPrecompileMock {
    struct Meta {
        bytes32 pubkey;
        bool is_signer;
        bool is_writable;
    }

    CreatePayerLedger public immutable ledger;

    constructor(CreatePayerLedger ledger_) {
        ledger = ledger_;
    }

    function pda(address user) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("mock-pda", user));
    }

    function operator() external pure returns (bytes32) {
        return keccak256("mock-operator");
    }

    function account_lamports(bytes32) external view returns (uint64) {
        return ledger.balance();
    }

    /// System Transfer data: u32 instruction index (2), then u64 lamports, little-endian.
    function invoke(bytes32, Meta[] calldata, bytes calldata data) external {
        uint64 lamports;
        for (uint256 i = 0; i < 8; ++i) {
            lamports |= uint64(uint8(data[4 + i])) << uint64(8 * i);
        }
        ledger.recordTransfer(lamports);
    }
}
