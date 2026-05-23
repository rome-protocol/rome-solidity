// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {
    HelperProgram,
    SplCached,
    AssociatedSplCached
} from "../interface.sol";
import {AccountReader} from "../cpi/AccountReader.sol";
import {Convert} from "../convert.sol";
import {ERC20Users} from "./erc20spl.sol";

/// @title  SPL_ERC20_cached
/// @notice Cache-based ERC20 wrapper around an SPL mint. Replaces the
///         CPI-based SPL_ERC20 on devnet. All mutations dispatch through
///         the cache-based precompile family (SplCached at 0xff..05,
///         AssociatedSplCached at 0xff..06). Reads use whichever
///         precompile gives the cleanest answer per the CU preference
///         order in the migration spec:
///           1. EthCall                              — HelperProgram.ata
///           2. HelperProgram CrossStateEthCall      — user_balance, allowance_of
///           3. CpiProgram CrossStateEthCall         — account_lamports, account_u64_at
///
/// @dev    Per the rome-evm-private one-track-per-contract HARD RULE,
///         this contract does NOT perform any CPI Invoke. Bridge methods
///         (bridgeOutToSolana, ensureRecipientAta) which require the
///         permanently-CPI-only create_ata_for_key are NOT exposed here
///         — they relocate to a separate sibling contract per follow-up
///         spec.
contract SPL_ERC20_cached is IERC20, IERC20Metadata {
    address public immutable cpi_program;
    bytes32 public immutable mint_id;
    uint8 public immutable decimals;

    string private _name;
    string private _symbol;
    ERC20Users private _users;

    error ERC20InvalidApprover(address approver);
    error ERC20InvalidSpender(address spender);
    error ERC20InsufficientAllowance(
        address spender,
        uint256 currentAllowance,
        uint256 requiredAllowance
    );

    constructor(
        bytes32 _mint_id,
        address _cpi_program,
        string memory name_,
        string memory symbol_,
        ERC20Users users_
    ) {
        SplTokenLib.SplMint memory mint = SplTokenLib.load_mint(_mint_id, _cpi_program);
        cpi_program = _cpi_program;
        mint_id = _mint_id;
        decimals = mint.decimals;
        _name = name_;
        _symbol = symbol_;
        _users = users_;
    }

    function name() external view returns (string memory) {
        return _name;
    }

    function symbol() external view returns (string memory) {
        return _symbol;
    }

    // ─── Stubs — implemented in subsequent tasks (Tasks 3-12 of the plan) ───

    function totalSupply() external view returns (uint256) {
        revert("not implemented");
    }

    function balanceOf(address) external view returns (uint256) {
        revert("not implemented");
    }

    function allowance(address, address) external view returns (uint256) {
        revert("not implemented");
    }

    function get_token_account(address) external view returns (bytes32) {
        revert("not implemented");
    }

    function transfer(address, uint256) external returns (bool) {
        revert("not implemented");
    }

    function transferFrom(address, address, uint256) external returns (bool) {
        revert("not implemented");
    }

    function approve(address, uint256) external returns (bool) {
        revert("not implemented");
    }

    function mint_to(address, uint256) external returns (bool) {
        revert("not implemented");
    }

    function ensure_token_account(address) external returns (bytes32) {
        revert("not implemented");
    }

    function create_token_account(address) external returns (bytes32) {
        revert("not implemented");
    }
}
