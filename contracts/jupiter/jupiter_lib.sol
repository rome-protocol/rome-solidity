// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {AssociatedSplTokenLib} from "../spl_token/associated_spl_token.sol";
import "../rome_evm_account.sol";

/// @title JupiterLib
/// @notice Passthrough invoke helper for Jupiter v6 swaps.
///         Routes must be computed off-chain via the Jupiter API.
///         The API returns serialized instruction data and account lists
///         which are passed directly to CPI.
library JupiterLib {
    /// Jupiter v6 program ID (JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4)
    bytes32 public constant PROGRAM_ID = 0x0479d55bf231c06eee74c56ece681507fdb1b2dea3f48e5102b1cda256bc138f;

    /// @notice Execute a pre-computed Jupiter route via CPI
    /// @param accounts AccountMeta array from Jupiter API (pubkeys as bytes32)
    /// @param data Raw instruction data from Jupiter API (includes discriminator)
    /// @dev Caller is responsible for:
    ///      1. Fetching route from Jupiter API
    ///      2. Converting base58 pubkeys to bytes32
    ///      3. Setting user_transfer_authority to their Rome PDA
    function execute_route(
        ICrossProgramInvocation.AccountMeta[] memory accounts,
        bytes memory data
    ) internal {
        CpiProgram.invoke(PROGRAM_ID, accounts, data);
    }

    /// @notice Read user's SPL token balance for a given mint
    /// @param user EVM address
    /// @param mint SPL token mint pubkey
    /// @return balance Token balance (raw units)
    function token_balance(address user, bytes32 mint) internal view returns (uint64 balance) {
        bytes32 user_pda = RomeEVMAccount.pda(user);
        (bytes32 ata,) = AssociatedSplTokenLib.associated_token_address(user_pda, mint);
        return SplTokenLib.load_token_amount(ata, cpi_program_address);
    }
}
