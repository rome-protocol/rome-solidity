// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../spl_token/spl_token.sol";
import "../interface.sol";
import "../rome_evm_account.sol";
import {AssociatedSplTokenLib} from "../spl_token/associated_spl_token.sol";
import {MplTokenMetadataLib} from "../mpl_token_metadata/lib.sol";

contract SPL_ERC20 is IERC20 {

    address public immutable cpi_program;
    bytes32 public immutable token_program;
    bytes32 public immutable mint_id;
    uint8 public immutable decimals;

    constructor(bytes32 _mint_id, address _cpi_program) {
        SplTokenLib.SplMint memory mint = SplTokenLib.load_mint(_mint_id, cpi_program);
        cpi_program = _cpi_program;
        mint_id = _mint_id;
        decimals = mint.decimals;
    }

    function get_owner(address user) internal view returns (bytes32) {
        bytes32 user_pda = RomeEVMAccount.pda(user);
        return user_pda;
    }

    function get_account_address(address account) public view returns (bytes32) {
        bytes32 account_pda = get_owner(account);
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

    function transfer(address to, uint256 value) external returns (bool) {
        bytes32 owner = get_owner(msg.sender);
        bytes32 source = get_account_address(msg.sender);
        bytes32 destination = get_account_address(to);
        bytes32[] memory signers = new bytes32[](1);
        signers[0] = owner;

        ICrossProgramInvocation.Instruction memory instr = SplTokenLib.transfer_checked(
            token_program, 
            source, 
            mint_id, 
            destination,
            owner,
            signers,
            uint64(value), 
            decimals
        );
        ICrossProgramInvocation(cpi_program).invoke_signed(instr.program_id, instr.accounts, instr.data);
        return true;
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        bytes32 owner_ = get_account_address(owner);
        bytes32 spender_ = get_account_address(spender);
        return SplTokenLib.allowance(owner_, spender_);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        bytes32 spender_ = get_account_address(spender);
        return SplTokenLib.approve(spender_, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        bytes32 from_ = get_account_address(from);
        bytes32 to_ = get_account_address(to);
        return SplTokenLib.transfer(from_, to_, value);
    }
}

