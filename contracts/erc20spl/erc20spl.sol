// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {AssociatedSplToken} from "../spl_token/associated_spl_token.sol";
import {ISystemProgram, ICrossProgramInvocation} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {Convert} from "../convert.sol";

contract ERC20Users {
    bytes32 payer_salt = Convert.bytes_to_bytes32(bytes("PAYER"));

    struct User {
        bytes32 payer;
        bytes32 owner;
        bytes32[] seeds;
    }

    mapping (address => User) users;

    function ensure_user(address user) public returns (User memory) {
        User memory existing_user = users[user];
        if (existing_user.owner == bytes32(0)) {
            User memory new_user = User({
                payer: RomeEVMAccount.get_payer(user, payer_salt),
                owner: RomeEVMAccount.pda(user),
                seeds: RomeEVMAccount.authority_seeds_with_salt_for_invoke(user, payer_salt)
            });

            users[user] = new_user;
            return new_user;
        } else {
            return existing_user;
        }
    }

    function get_user(address user) public view returns (User memory) {
        User memory existing_user = users[user];
        require(existing_user.owner != bytes32(0), "User does not exist");
        return existing_user;
    }
}

contract SPL_ERC20 is IERC20, IERC20Metadata {
    // SystemProgram
    bytes32 public constant system_program_id = 0x0000000000000000000000000000000000000000000000000000000000000000;
    // TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
    bytes32 public constant token_program_id = 0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9;
    // ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
    bytes32 public constant associated_token_program_id = 0x8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859;

    address public immutable cpi_program;
    bytes32 public immutable mint_id;
    uint8 public immutable decimals;

    string private _name;
    string private _symbol;
    ERC20Users private _users;
    mapping(address => bytes32) private _accounts;
    

    mapping(address account => mapping(address spender => uint256)) private _allowances;

    error ERC20InvalidApprover(address approver);
    error ERC20InvalidSpender(address spender);
    error ERC20InsufficientAllowance(address spender, uint256 currentAllowance, uint256 requiredAllowance);

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

    /**
     * Helper function to create an associated token account for a user if it doesn't exist, and return the associated token account address.
     * @param user EVM address of the user for whom to create the associated token account
     * @return associated_account_address The address of the associated token account created or existing for the user
     */
    function create_token_account(address user) public returns(bytes32) {
        ERC20Users.User memory u = _users.ensure_user(user);
        (bytes32 program_id, ICrossProgramInvocation.AccountMeta[] memory accounts, bytes memory data, bytes32 associated_account_address) = 
            AssociatedSplToken.create_associated_token_account(
                token_program_id, 
                u.owner, 
                mint_id, 
                system_program_id,
                token_program_id,
                associated_token_program_id
            );
        
        ICrossProgramInvocation(cpi_program).invoke_signed(program_id, accounts, data, u.seeds);
        _accounts[user] = associated_account_address;
        return associated_account_address;
    }

    /**
     * Checks if the user has an associated token account, and if not, creates one. Returns the associated token account address.
     * @param user EVM address of the user for whom to ensure the associated token account exists
     * @return associated_account_address The address of the associated token account created or existing for the user
     */
    function ensure_token_account(address user) public returns (bytes32) {
        bytes32 token_account = _accounts[user];
        if (token_account == bytes32(0)) {
            return create_token_account(user);
        } else {
            return token_account;
        }
    }

    /**
     * Gets the associated token account address for a user. Reverts if the user does not have an associated token account.
     * @param user EVM address of the user whose associated token account address to retrieve
     * @return associated_account_address The address of the associated token account for the user
     */
    function get_token_account(address user) public view returns (bytes32) {
        bytes32 token_account = _accounts[user];
        require(token_account != bytes32(0), "Token account does not exist");
        return token_account;
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
        bytes32 token_account = get_token_account(account);
        return uint256(SplTokenLib.load_token_amount(token_account, cpi_program));
    }

    function transfer(address to, uint256 value) public virtual returns (bool) {
        return _transfer(_users.get_user(msg.sender), msg.sender, to, value);
    }

    /**
     * Internal transfer function that performs a token transfer by invoking the SPL Token program's TransferChecked instruction via CPI.
     * @param user The User struct containing payer and seeds for the sender
     * @param from EVM address of the sender
     * @param to EVM address of the recipient
     * @param value amount of tokens to transfer (in the smallest unit, e.g. if decimals is 6, then value should be in micro-units)
     * 
     * @return success Returns true if the transfer was successful
     */
    function _transfer(
        ERC20Users.User memory user,
        address from, 
        address to, 
        uint256 value
    ) internal returns (bool) {
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");

        bytes32[] memory signers = new bytes32[](2);
        signers[0] = user.owner; // signer is the user's PDA
        signers[1] = user.payer; // payer is the user's payer account

        (bytes32 program_id, ICrossProgramInvocation.AccountMeta[] memory accounts, bytes memory data) = 
        SplTokenLib.transfer_checked(
            token_program_id, 
            get_token_account(from), 
            mint_id, 
            get_token_account(to),
            user.owner,
            signers,
            uint64(value), 
            decimals
        );

        ICrossProgramInvocation(cpi_program).invoke_signed(program_id, accounts, data, user.seeds);
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
        return _transfer(_users.get_user(spender), from, to, value);
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

    function mint_to(address to, uint256 value) public virtual returns (bool) {
        require(value <= type(uint64).max, "Mint amount exceeds uint64");

        ERC20Users.User memory user = _users.get_user(msg.sender);
        bytes32 to_account = ensure_token_account(to);
        bytes32[] memory signers = new bytes32[](2);
        signers[0] = user.owner; // signer is the user's PDA
        signers[1] = user.payer; // payer is the user's payer account

        (bytes32 program_id, ICrossProgramInvocation.AccountMeta[] memory accounts, bytes memory data) = SplTokenLib.mint_to_checked(
            token_program_id,
            mint_id,
            to_account,
            user.owner,
            signers,
            uint64(value),
            decimals
        );

        ICrossProgramInvocation(cpi_program).invoke_signed(program_id, accounts, data, user.seeds);
        return true;
    }
}

