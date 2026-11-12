// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20Users} from "./erc20spl.sol";
import {SPL_ERC20_cached} from "./erc20spl_cached.sol";
import {ERC20SPLHookedDeployer} from "./erc20spl_hooked_deployer.sol";
import {RomeNaming} from "./RomeNaming.sol";
import {MintNameReader} from "./MintNameReader.sol";
import {HelperProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {Convert} from "../convert.sol";
import {AccountReader} from "../cpi/AccountReader.sol";

/// @title ERC20SPLNamedFactory
/// @notice Registers a Solana mint once and deploys its ERC-20 wrapper, named by RomeNaming:
///         "<origin name cut to 25 bytes> (Rome)", origin symbol cut to 10 bytes.
/// @dev No owner, no upgrade, no setter; no caller picks a name. The mint is the key, never the
///      symbol. `grandfatherHash` is keccak256(abi.encode(list)) of the fixed-at-deploy list of
///      `(uint32 network, bytes32 mint, address wrapper)` entries.
contract ERC20SPLNamedFactory {
    enum WrapperKind {
        None,
        Cached,
        Token2022HookedCpi
    }

    struct GrandfatherEntry {
        uint32 network;
        bytes32 mint;
        address wrapper;
    }

    uint8 public constant DEFAULT_DECIMALS = 9;

    mapping(bytes32 => address) public token_by_mint;
    mapping(bytes32 => WrapperKind) public wrapper_kind_by_mint;
    mapping(address => uint64) public creator_nonce;
    /// @notice The wrapper a grandfathered mint already has, else zero.
    mapping(bytes32 => address) public grandfathered;

    bytes32 public immutable grandfatherHash;
    address public immutable cpi_program;
    ERC20Users public immutable users;
    ERC20SPLHookedDeployer public immutable hooked_wrapper_deployer;

    event TokenCreated(
        address indexed creator,
        bytes32 indexed mint,
        address indexed wrapper,
        string name,
        string symbol,
        uint64 nonce
    );

    error AlreadyRegistered();
    error Grandfathered();
    error NoName();
    error BadName();
    error BadSymbol();
    /// @dev Metadata pointer to an account that is neither the mint nor its Metaplex account.
    error ExternalPointer();
    error NotMintAuthority();
    /// @dev The mint asserts a name: use `add_spl_token_with_metadata`.
    error MintAssertsName();
    /// @dev Zero mint, zero wrapper or repeated mint in the grandfather list.
    error BadGrandfatherList();
    error MintAccountAlreadyExists(bytes32 mint);

    constructor(address _cpi_program, GrandfatherEntry[] memory list) {
        cpi_program = _cpi_program;
        users = new ERC20Users();
        hooked_wrapper_deployer = new ERC20SPLHookedDeployer();
        for (uint256 i = 0; i < list.length; i++) {
            GrandfatherEntry memory g = list[i];
            if (g.mint == bytes32(0) || g.wrapper == address(0) || grandfathered[g.mint] != address(0)) {
                revert BadGrandfatherList();
            }
            grandfathered[g.mint] = g.wrapper;
        }
        grandfatherHash = keccak256(abi.encode(list));
    }

    /// @notice Registers `mint`, named from the mint's own metadata. Anyone may call.
    function add_spl_token_with_metadata(bytes32 mint) public returns (address) {
        (string memory name, string memory symbol) = _fromMetadata(mint);
        return _register(mint, name, symbol);
    }

    /// @notice Registers a mint whose authority is the caller's PDA and that asserts no name,
    ///         naming it from the given strings by the same rule.
    function add_spl_token_by_authority(bytes32 mint, string calldata originName, string calldata originSymbol)
        public
        returns (address)
    {
        _checkNew(mint);
        (bool ok, bytes32 authority) = MintNameReader.mintAuthority(cpi_program, mint);
        if (!ok || authority == bytes32(0) || authority != HelperProgram.pda(msg.sender)) revert NotMintAuthority();
        (MintNameReader.Source source, bytes memory readName,) = MintNameReader.read(cpi_program, mint);
        if (source == MintNameReader.Source.ExternalPointer) revert ExternalPointer();
        if (readName.length != 0) revert MintAssertsName();
        string memory name = RomeNaming.romeName(originName);
        string memory symbol = RomeNaming.romeSymbol(originSymbol);
        return _register(mint, name, symbol);
    }

    /// @notice The name and symbol `add_spl_token_with_metadata(mint)` would use, or its revert.
    function preview(bytes32 mint) external view returns (string memory name, string memory symbol) {
        return _fromMetadata(mint);
    }

    /// @dev Check order: registered, grandfathered, metadata read, whole name, whole symbol.
    function _fromMetadata(bytes32 mint) internal view returns (string memory name, string memory symbol) {
        _checkNew(mint);
        (MintNameReader.Source source, bytes memory readName, bytes memory readSymbol) =
            MintNameReader.read(cpi_program, mint);
        if (source == MintNameReader.Source.ExternalPointer) revert ExternalPointer();
        if (readName.length == 0) revert NoName();
        name = RomeNaming.romeName(string(readName));
        symbol = RomeNaming.romeSymbol(string(readSymbol));
    }

    function _checkNew(bytes32 mint) internal view {
        if (token_by_mint[mint] != address(0)) revert AlreadyRegistered();
        if (grandfathered[mint] != address(0)) revert Grandfathered();
    }

    function _register(bytes32 mint, string memory name, string memory symbol) internal returns (address) {
        // An armed transfer hook needs the hooked wrapper; any other mint gets the cached one.
        (,, bytes32 hook_program,,) = HelperProgram.mint_info(mint);
        address wrapper;
        if (hook_program != bytes32(0)) {
            wrapper = hooked_wrapper_deployer.deploy(mint, cpi_program, name, symbol, users);
            wrapper_kind_by_mint[mint] = WrapperKind.Token2022HookedCpi;
        } else {
            wrapper = address(new SPL_ERC20_cached(mint, cpi_program, name, symbol, users));
            wrapper_kind_by_mint[mint] = WrapperKind.Cached;
        }
        token_by_mint[mint] = wrapper;
        emit TokenCreated(msg.sender, mint, wrapper, name, symbol, creator_nonce[msg.sender]);
        return wrapper;
    }

    /// @notice The mint `create_token_mint` will create next for `user`, and its PDA seed.
    function get_current_mint(address user) public view returns (bytes32, bytes32) {
        uint64 nonce = creator_nonce[user];

        bytes32 mintSeed =
            bytes32((uint256(uint32(bytes4("MINT"))) << 224) | (uint256(nonce) << 160) | uint160(address(this)));
        return (RomeEVMAccount.pda_with_salt(user, mintSeed), mintSeed);
    }

    function _assert_mint_account_missing(bytes32 mint) internal view {
        if (token_by_mint[mint] != address(0)) revert AlreadyRegistered();
        if (AccountReader.lamportsOf(mint) != 0) {
            revert MintAccountAlreadyExists(mint);
        }
    }

    /// @notice Creates and initialises a mint (decimals 9) whose authority is the caller's PDA.
    function create_token_mint() external returns (bytes32) {
        (bytes32 mint, bytes32 mintSeed) = get_current_mint(msg.sender);
        _assert_mint_account_missing(mint);
        bytes32 user = HelperProgram.pda(msg.sender);

        // One dispatch, so no one can initialise a half-made mint and seize its authority.
        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_and_init_mint(uint8,bytes32,bool,bytes32,bytes32)",
                DEFAULT_DECIMALS,
                user,
                false,
                bytes32(0),
                mintSeed
            )
        );
        require(success, string(Convert.revert_msg(result)));

        creator_nonce[msg.sender] = creator_nonce[msg.sender] + 1;
        return mint;
    }

    /// @notice No-op for existing clients: reverts unless `mint` is initialised.
    function init_token_mint(bytes32 mint) external view {
        bytes memory isInitialized = AccountReader.readBytesAt(mint, 45, 1);
        require(isInitialized[0] == 0x01, "mint not initialized; create_token_mint now initializes atomically");
    }
}
