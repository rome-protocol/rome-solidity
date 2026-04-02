// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./erc20spl.sol";
import {MplTokenMetadataLib} from "../mpl_token_metadata/lib.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {SystemProgramLib} from "../system_program/system_program.sol";
import {ICrossProgramInvocation, ISystemProgram, SystemProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {Convert} from "../convert.sol";

contract ERC20SPLFactory {
    uint8 public constant DEFAULT_DECIMALS = 9;
    uint64 internal constant SPL_MINT_LEN = 82;
    string internal constant METAPLEX_TOKEN_METADATA_PROGRAM_NAME = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

    mapping(bytes32 => address) public token_by_mint;
    mapping(bytes32 => bytes32) public mint_by_symbol_hash;
    mapping(bytes32 => address) public token_by_symbol_hash;
    mapping(address => uint64) public creator_nonce;

    bytes32 public immutable mpl_token_metadata_program;
    address public immutable cpi_program;
    ERC20Users private _users;

    event TokenCreated(
        address indexed creator,
        bytes32 indexed mint,
        address indexed wrapper,
        string name,
        string symbol,
        uint64 nonce
    );

    constructor(address _cpi_program) {
        cpi_program = _cpi_program;
        mpl_token_metadata_program = SystemProgram.base58_to_bytes32(bytes(METAPLEX_TOKEN_METADATA_PROGRAM_NAME));
        _users = new ERC20Users();
    }

    function _check_symbol_hash_exists(bytes32 symbolHash) internal view {
        require(token_by_symbol_hash[symbolHash] == address(0), "Token with symbol exists");
        require(mint_by_symbol_hash[symbolHash] == bytes32(0), "Token with symbol exists");
    }

    function add_spl_token_with_metadata(bytes32 mint)
    public
    returns (address) {
        require(token_by_mint[mint] == address(0), "Token exists");

        (bool metadata_exists, MplTokenMetadataLib.Metadata memory metadata) = MplTokenMetadataLib.load_metadata(
            mint, mpl_token_metadata_program, cpi_program
        );
        require(metadata_exists, "Metadata does not exist");

        bytes32 symbolHash = keccak256(bytes(metadata.symbol));
        _check_symbol_hash_exists(symbolHash);
    
        SPL_ERC20 new_contract = new SPL_ERC20(mint, cpi_program, metadata.name, metadata.symbol, _users);
        token_by_mint[mint] = address(new_contract);
        return address(new_contract);
    }

    function add_spl_token_no_metadata(bytes32 mint, string memory name, string memory symbol)
    public
    returns (address) {
        require(token_by_mint[mint] == address(0), "Token exists");
        SPL_ERC20 new_contract = new SPL_ERC20(mint, cpi_program, name, symbol, _users);
        token_by_mint[mint] = address(new_contract);
        return address(new_contract);
    }

    function create_token_account()
    public
    returns (bytes32) {
        ERC20Users.User memory user = _users.ensure_user(msg.sender);
        uint64 nonce = creator_nonce[msg.sender];
        (bytes32 mint) = _derive_mint_address(msg.sender, nonce);

        require(token_by_mint[mint] == address(0), "Token exists");
        _create_mint_account(user, mint, user.seeds);
        return mint;
    }


    function init_token_account(string memory name, string memory symbol)
    public
    returns (address) {
        bytes32 symbolHash = keccak256(bytes(symbol));
        _check_symbol_hash_exists(symbolHash);

        ERC20Users.User memory user = _users.ensure_user(msg.sender);
        uint64 nonce = creator_nonce[msg.sender];
        (bytes32 mint) = _derive_mint_address(msg.sender, nonce);
        _initialize_mint(mint, user.owner);
        SPL_ERC20 newContract = new SPL_ERC20(mint, cpi_program, name, symbol, _users);

        creator_nonce[msg.sender] = nonce + 1;
        token_by_mint[mint] = address(newContract);
        mint_by_symbol_hash[symbolHash] = mint;
        token_by_symbol_hash[symbolHash] = address(newContract);

        emit TokenCreated(msg.sender, mint, address(newContract), name, symbol, nonce);

        return address(newContract);
    }

    function _derive_mint_address(address creator, uint64 nonce) internal view returns (bytes32 mint) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        bytes memory creatorSeed = abi.encodePacked(creator);
        bytes memory nonceSeed = abi.encodePacked(nonce);
        seeds[0] = ISystemProgram.Seed(creatorSeed);
        seeds[1] = ISystemProgram.Seed(nonceSeed);

        (mint,) = SystemProgram.find_program_address(SystemProgram.rome_evm_program_id(), seeds);
        return mint;
    }

    function _create_mint_account(ERC20Users.User memory user, bytes32 mint, bytes32[] memory mintSeeds) internal {
        SystemProgramLib.Instruction memory createMintAccount = SystemProgramLib.create_account(
            user.payer,
            mint,
            RomeEVMAccount.minimum_balance(SPL_MINT_LEN),
            SPL_MINT_LEN,
            SplTokenLib.SPL_TOKEN_PROGRAM
        );

        ICrossProgramInvocation(cpi_program).invoke_signed(
            createMintAccount.program_id,
            createMintAccount.accounts,
            createMintAccount.data,
            mintSeeds
        );
    }

    function _initialize_mint(bytes32 mint, bytes32 mintAuthority) internal {
        (
            bytes32 tokenProgramId,
            ICrossProgramInvocation.AccountMeta[] memory initAccounts,
            bytes memory initData
        ) = SplTokenLib.initialize_mint2(
            SplTokenLib.SPL_TOKEN_PROGRAM,
            mint,
            mintAuthority,
            false,
            bytes32(0),
            DEFAULT_DECIMALS
        );

        ICrossProgramInvocation(cpi_program).invoke(tokenProgramId, initAccounts, initData);
    }
}
