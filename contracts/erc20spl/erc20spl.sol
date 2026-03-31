// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {ICrossProgramInvocation} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {AssociatedSplTokenLib} from "../spl_token/associated_spl_token.sol";
import {UnifiedLiquidity} from "../spl_token/unified_liquidity.sol";
// import {MplTokenMetadataLib} from "../mpl_token_metadata/lib.sol";

contract SPL_ERC20 is IERC20, IERC20Metadata {

    address public immutable cpi_program;
    bytes32 public immutable token_program;
    bytes32 public immutable mint_id;
    uint8 public immutable decimals;

    string private _name;
    string private _symbol;

    mapping(address account => mapping(address spender => uint256)) private _allowances;

    error ERC20InvalidApprover(address approver);
    error ERC20InvalidSpender(address spender);
    error ERC20InsufficientAllowance(address spender, uint256 currentAllowance, uint256 requiredAllowance);

    constructor(
        bytes32 _mint_id, 
        address _cpi_program, 
        string memory name_, 
        string memory symbol_
    ) {
        SplTokenLib.SplMint memory mint = SplTokenLib.load_mint(_mint_id, cpi_program);
        cpi_program = _cpi_program;
        mint_id = _mint_id;
        decimals = mint.decimals;
        _name = name_;
        _symbol = symbol_;
    }

    function name() public view virtual returns (string memory) {
        return _name;
    }

    function symbol() public view virtual returns (string memory) {
        return _symbol;
    }

    function totalSupply() public view virtual returns (uint256) {
        SplTokenLib.SplMint memory mint = SplTokenLib.load_mint(mint_id, cpi_program);
        return uint256(mint.supply);
    }

    function balanceOf(address account) public view virtual returns (uint256) {
        return uint256(SplTokenLib.load_token_amount(UnifiedLiquidity.get_token_account(account, mint_id), cpi_program));
    }

    function transfer(address to, uint256 value) public virtual returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");
        
        bytes32 owner = UnifiedLiquidity.get_payer_account(from);
        bytes32[] memory signers = new bytes32[](1);
        signers[0] = owner;

        (bytes32 program_id, ICrossProgramInvocation.AccountMeta[] memory accounts, bytes memory data) = 
        SplTokenLib.transfer_checked(
            token_program, 
            UnifiedLiquidity.get_token_account(from, mint_id), 
            mint_id, 
            UnifiedLiquidity.get_token_account(to, mint_id),
            owner,
            signers,
            uint64(value), 
            decimals
        );
        bytes32[] memory salts = new bytes32[](1);
        salts[0] = UnifiedLiquidity.default_salt;
        ICrossProgramInvocation(cpi_program).invoke_signed(program_id, accounts, data, salts);
        return true;
    }

    function allowance(address owner, address spender) public view virtual returns (uint256) {
        return _allowances[owner][spender];
    }

    function approve(address spender, uint256 value) public virtual returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

 
    function _approve(address owner, address spender, uint256 value) internal {
        _approve(owner, spender, value, true);
    }

    function _approve(address owner, address spender, uint256 value, bool emitEvent) internal virtual {
        if (owner == address(0)) {
            revert ERC20InvalidApprover(address(0));
        }
        if (spender == address(0)) {
            revert ERC20InvalidSpender(address(0));
        }
        _allowances[owner][spender] = value;
        if (emitEvent) {
            emit Approval(owner, spender, value);
        }
    }

    function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
        address spender = msg.sender;
        _spendAllowance(from, spender, value);
        return _transfer(from, to, value);
    }

    function _spendAllowance(address owner, address spender, uint256 value) internal virtual {
        uint256 currentAllowance = allowance(owner, spender);
        if (currentAllowance < type(uint256).max) {
            if (currentAllowance < value) {
                revert ERC20InsufficientAllowance(spender, currentAllowance, value);
            }
            unchecked {
                _approve(owner, spender, currentAllowance - value, false);
            }
        }
    }
}

