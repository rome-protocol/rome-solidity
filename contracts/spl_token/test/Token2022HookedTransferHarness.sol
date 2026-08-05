// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICrossProgramInvocation} from "../../interface.sol";
import {Token2022HookedTransfer} from "../token2022_hooked_transfer.sol";

contract Token2022HookedTransferHarness {
    function plan(
        bytes32 source,
        bytes32 mint,
        bytes32 destination,
        bytes32 authority,
        uint64 amount,
        uint8 decimals,
        ICrossProgramInvocation.AccountMeta[] memory hookMetas
    ) external pure returns (bytes memory, ICrossProgramInvocation.AccountMeta[] memory) {
        return Token2022HookedTransfer.plan(
            source, mint, destination, authority, amount, decimals, hookMetas
        );
    }

    function validate(
        bytes32 hookProgram,
        bytes32 validation,
        ICrossProgramInvocation.AccountMeta[] memory hookMetas
    ) external pure {
        Token2022HookedTransfer.validate(hookProgram, validation, hookMetas);
    }
}
