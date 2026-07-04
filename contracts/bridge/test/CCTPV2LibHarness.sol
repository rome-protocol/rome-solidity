// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CCTPV2Lib} from "../ICCTPV2.sol";
import {ICrossProgramInvocation} from "../../interface.sol";

/// @notice Test harness exposing CCTPV2Lib internals for network-independent
///         unit tests (same pattern as contracts/oracle/test harnesses).
contract CCTPV2LibHarness {
    function encode(
        uint64 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        bytes32 destinationCaller,
        uint64 maxFee,
        uint32 minFinalityThreshold
    ) external pure returns (bytes memory) {
        return CCTPV2Lib.encodeDepositForBurn(CCTPV2Lib.DepositForBurnParams({
            amount: amount,
            destinationDomain: destinationDomain,
            mintRecipient: mintRecipient,
            destinationCaller: destinationCaller,
            maxFee: maxFee,
            minFinalityThreshold: minFinalityThreshold
        }));
    }

    function build(CCTPV2Lib.DepositForBurnAccounts memory a)
        external
        pure
        returns (ICrossProgramInvocation.AccountMeta[] memory)
    {
        return CCTPV2Lib.buildDepositForBurnAccounts(a);
    }
}
