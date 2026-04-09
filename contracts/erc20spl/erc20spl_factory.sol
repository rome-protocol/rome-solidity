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
    ERC20Users public immutable users;

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
        users = new ERC20Users();
    }

    function _check_symbol_hash_exists(bytes32 symbolHash) internal view {
        require(token_by_symbol_hash[symbolHash] == address(0), "Token with symbol exists");
        require(mint_by_symbol_hash[symbolHash] == bytes32(0), "Token with symbol exists");
    }

    function _register_contract(bytes32 mint, string memory name, string memory symbol) internal returns(address) {
        bytes32 symbolHash = keccak256(bytes(symbol));
        _check_symbol_hash_exists(symbolHash);

        SPL_ERC20 new_contract = new SPL_ERC20(mint, cpi_program, name, symbol, users);
        token_by_mint[mint] = address(new_contract);
        mint_by_symbol_hash[symbolHash] = mint;
        token_by_symbol_hash[symbolHash] = address(new_contract);
        return address(new_contract);
    }

    /**
     * Registers existing SPL token and deploys ERC20 wrapper for it. 
     * Name and symbol are loaded from the token's metadata account, 
     * so the token must have metadata already created on Solana for this function to work. 
     * If the token does not have metadata or if the metadata is missing name or symbol, 
     * this function will revert. Symbol must be unique across all tokens created through this factory.
     * @param mint SPL token mint address
     */
    function add_spl_token_with_metadata(bytes32 mint)
    public
    returns (address) {
        require(token_by_mint[mint] == address(0), "Token exists");

        (bool metadata_exists, MplTokenMetadataLib.Metadata memory metadata) = MplTokenMetadataLib.load_metadata(
            mint, mpl_token_metadata_program, cpi_program
        );
        require(metadata_exists, "Metadata does not exist");
        return _register_contract(mint, metadata.name, metadata.symbol);
    }

    /**
     * Registers existing SPL token without metadata and deploys ERC20 wrapper for it.
     * @param mint SPL token mint address. The mint account must already exist and be initialized, 
     * but it does not need to have metadata associated with it.
     * @param name Name of the token.
     * @param symbol Symbol of the token. Symbol must be unique across all tokens created through this factory.
     */
    function add_spl_token_no_metadata(bytes32 mint, string memory name, string memory symbol)
    public
    returns (address) {
        require(token_by_mint[mint] == address(0), "Token exists");
        return _register_contract(mint, name, symbol);
    }

    function create_user()
    public {
        users.ensure_user(msg.sender);
        RomeEVMAccount.create_payer(msg.sender, 1000000000, users.payer_salt());
    }

    /**
     * Derives the address of the mint account that will be created for the user in the next call to create_token_mint,
     * based on the user's current nonce and this factory's address. This can be used by clients to know the mint
     * address before it is created, so they can create metadata accounts for it or perform other setup steps on
     * Solana before calling create_token_mint.
     * @return (bytes32 mint, bytes32 mintSeed) The address of the mint account that will be created for the user in
     *              the next call to create_token_mint, and the seed that can be used to derive it.
     */
    function get_current_mint(address user) public view returns (bytes32, bytes32) {
        uint64 nonce = creator_nonce[user];

        // [ "MINT" (4 bytes) | nonce (8 bytes) | factory address (20 bytes) ]
        bytes32 mintSeed = bytes32(
            (uint256(uint32(bytes4("MINT"))) << 224) |
            (uint256(nonce) << 160) |
            uint160(address(this))
        );
        return (RomeEVMAccount.pda_with_salt(user, mintSeed), mintSeed);
    }

    /**
     * Creates new SPL token mint.
     * Token mint is derived from the creator's address and their current nonce, so each creator can create multiple tokens 
     * by calling this function multiple times. This function only creates the mint account and does not initialize it, 
     * so the returned mint address will not be a valid SPL token until the mint account is initialized 
     * (e.g. by calling init_token_account with the same name and symbol that will be used for the ERC20 wrapper).
     *
     * @return (bytes32 mint) Address of the created SPL Token mint.
     */
    function create_token_mint() external returns (bytes32) {
        ERC20Users.User memory user = users.get_user(msg.sender);
        (bytes32 mint, bytes32 mintSeed) = get_current_mint(msg.sender);
        require(token_by_mint[mint] == address(0), "Token exists");

        SystemProgramLib.Instruction memory createMintAccount = SystemProgramLib.create_account(
            user.payer,
            mint,
            RomeEVMAccount.minimum_balance(SPL_MINT_LEN),
            SPL_MINT_LEN,
            SplTokenLib.SPL_TOKEN_PROGRAM
        );

        bytes32[] memory seeds = new bytes32[](2);
        seeds[0] = user.seed;
        seeds[1] = mintSeed;

        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                createMintAccount.program_id,
                createMintAccount.accounts,
                abi.encodePacked(createMintAccount.data),
                seeds
            )
        );

        require (success, string(Convert.revert_msg(result)));
        uint64 nonce = creator_nonce[msg.sender];
        creator_nonce[msg.sender] = nonce + 1;
        return mint;
    }

    /**
     * Initializes previously created mint account.
     */
    function init_token_mint(bytes32 mint) external {
        ERC20Users.User memory user = users.get_user(msg.sender);

        (
            bytes32 tokenProgramId,
            ICrossProgramInvocation.AccountMeta[] memory initAccounts,
            bytes memory initData
        ) = SplTokenLib.initialize_mint(
            SplTokenLib.SPL_TOKEN_PROGRAM,
            mint,
            user.owner,
            false,
            bytes32(0),
            DEFAULT_DECIMALS
        );

        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                tokenProgramId,
                initAccounts,
                initData
            )
        );

        require (success, string(Convert.revert_msg(result)));
    }
}
