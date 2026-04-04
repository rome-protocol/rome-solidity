// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import "./jupiter_lib.sol";
import "../rome_evm_account.sol";

/// @title JupiterSwap
/// @notice Convenience contract for executing Jupiter swaps.
///         Automatically resolves the user's Rome PDA as signer.
contract JupiterSwap {
    address public immutable cpi_program;

    constructor(address _cpi_program) {
        cpi_program = _cpi_program;
    }

    /// @notice Execute a pre-computed Jupiter route
    /// @param accounts Full account list from Jupiter API
    /// @param data Raw instruction data from Jupiter API
    function swap(
        ICrossProgramInvocation.AccountMeta[] calldata accounts,
        bytes calldata data
    ) external {
        ICrossProgramInvocation(cpi_program).invoke(
            JupiterLib.PROGRAM_ID,
            accounts,
            data
        );
    }

    /// @notice Read caller's token balance
    function balance(bytes32 mint) external view returns (uint64) {
        return JupiterLib.token_balance(msg.sender, mint);
    }
}
