// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../spl_token/spl_token.sol";
import "../interface.sol";
import "../rome_evm_account.sol";
import {AssociatedSplTokenLib} from "../spl_token/associated_spl_token.sol";

/// @title SPL_ERC20
/// @notice ERC-20 transparent proxy over an SPL token mint.
///         balanceOf reads directly from the user's SPL ATA on Solana.
///         transfer uses the SPL Token precompile.
///         approve/allowance use EVM-level storage (standard ERC-20 pattern) because
///         the SPL Token precompile does not yet support approve/transfer_from natively.
///         transferFrom checks EVM allowance, then executes via SPL precompile
///         delegatecall (msg.sender context = spender who has delegation on-chain,
///         OR uses EVM allowance for same-user operations).
contract SPL_ERC20 is IERC20 {

    address public immutable cpi_program;
    bytes32 public immutable mint_id;
    uint8 public immutable decimals;

    /// @dev EVM-level allowances (standard ERC-20 pattern)
    mapping(address => mapping(address => uint256)) private _allowances;

    constructor(bytes32 _mint_id, address _cpi_program) {
        // Fix: use _cpi_program parameter directly (was using uninitialized cpi_program)
        SplTokenLib.SplMint memory mint = SplTokenLib.load_mint(_mint_id, _cpi_program);
        cpi_program = _cpi_program;
        mint_id = _mint_id;
        decimals = mint.decimals;
    }

    /// @dev Get the SPL ATA address for a given EVM account
    function get_account_address(address account) public view returns (bytes32) {
        bytes32 account_pda = RomeEVMAccount.pda(account);
        (bytes32 token_account,) = AssociatedSplTokenLib.associated_token_address(account_pda, mint_id);
        return token_account;
    }

    function totalSupply() external view returns (uint256) {
        SplTokenLib.SplMint memory mint = SplTokenLib.load_mint(mint_id, cpi_program);
        return uint256(mint.supply);
    }

    function balanceOf(address account) external view returns (uint256) {
        return uint256(SplTokenLib.load_token_amount(get_account_address(account), cpi_program));
    }

    function transfer(address to_, uint256 value) external returns (bool) {
        bytes32 from = get_account_address(msg.sender);
        bytes32 bytes_to_ = get_account_address(to_);
        bool success = SplTokenLib.transfer(from, bytes_to_, value);
        emit Transfer(msg.sender, to_, value);
        return success;
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    function approve(address spender, uint256 value) external returns (bool) {
        require(value <= type(uint64).max, "Amount exceeds uint64");
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        // Check EVM-level allowance
        uint256 currentAllowance = _allowances[from][msg.sender];
        require(currentAllowance >= value, "ERC20: insufficient allowance");

        // Decrease allowance
        _allowances[from][msg.sender] = currentAllowance - value;

        // Execute SPL transfer from owner's ATA to recipient's ATA
        // Uses delegatecall to SPL precompile — signs with msg.sender's PDA.
        // For self-referencing transferFrom (owner == spender), this works directly.
        // For cross-user transferFrom, the spender must have SPL delegation from the owner.
        bytes32 from_ata = get_account_address(from);
        bytes32 to_ata = get_account_address(to);
        SplTokenLib.transfer(from_ata, to_ata, value);

        emit Transfer(from, to, value);
        return true;
    }
}
