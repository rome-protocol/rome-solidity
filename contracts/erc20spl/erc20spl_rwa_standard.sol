// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20Users} from "./erc20spl.sol";
import {SPL_ERC20_cached} from "./erc20spl_cached.sol";
import {SplCached} from "../interface.sol";
import {SolanaConstants} from "../cpi/SolanaConstants.sol";

/// @notice The mint is not Token-2022, so it cannot be admitted to the
/// strict Solana-native RWA route.
error RwaStandardToken2022Required(bytes32 mint, bytes32 tokenProgram);

/// @notice A transfer fee breaks exact ordinary ERC-20 debit/credit semantics.
error RwaStandardTransferFeeUnsupported(bytes32 mint, uint16 feeBps);

/// @title SPL_ERC20_RwaStandard
/// @notice Narrow ERC-20 facade for the first Solana-native RWA route.
///
/// @dev This is deliberately stricter than `SPL_ERC20_cached`: it requires a
/// Token-2022 mint with no armed transfer hook and no transfer fee. The parent
/// constructor provides the hook check; this constructor adds the program and
/// fee checks. It does *not* decide issuer eligibility: DefaultAccountState,
/// ACL admission, thaw/freeze and revocation remain native-policy facts that
/// B0a/B1 prove and record in the approval manifest.
contract SPL_ERC20_RwaStandard is SPL_ERC20_cached {
    constructor(
        bytes32 mint,
        address cpiProgram,
        string memory name,
        string memory symbol,
        ERC20Users users
    ) SPL_ERC20_cached(mint, cpiProgram, name, symbol, users) {
        (bytes32 tokenProgram, , , uint16 feeBps, ) = SplCached.mint_info(mint);
        if (tokenProgram != SolanaConstants.TOKEN_2022_PROGRAM) {
            revert RwaStandardToken2022Required(mint, tokenProgram);
        }
        if (feeBps != 0) {
            revert RwaStandardTransferFeeUnsupported(mint, feeBps);
        }
    }
}
