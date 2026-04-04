// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {KaminoLendingLib} from "../kamino/kamino_lending_lib.sol";

/// @title ILending
/// @notice Protocol-agnostic lending interface
/// @dev Backed by Kamino Lending (KLend)
interface ILending {
    function deposit(bytes32 reserve, uint64 amount,
        ICrossProgramInvocation.AccountMeta[] calldata remaining_accounts) external;

    function withdraw(bytes32 reserve, uint64 collateral_amount,
        ICrossProgramInvocation.AccountMeta[] calldata remaining_accounts) external;

    function borrow(bytes32 reserve, uint64 amount,
        ICrossProgramInvocation.AccountMeta[] calldata remaining_accounts) external;

    function repay(bytes32 reserve, uint64 amount,
        ICrossProgramInvocation.AccountMeta[] calldata remaining_accounts) external;

    function get_reserve_info(bytes32 reserve_pubkey)
        external view returns (KaminoLendingLib.ReserveSummary memory);

    function get_obligation_info(bytes32 obligation_pubkey)
        external view returns (KaminoLendingLib.ObligationSummary memory);

    function health_factor(bytes32 obligation_pubkey)
        external view returns (uint256 health_factor_e18);
}
