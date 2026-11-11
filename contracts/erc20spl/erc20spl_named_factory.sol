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
/// @notice The wrapper factory that names every wrapper by rule. Anyone can register a Solana mint once, and
///         nobody chooses its name: a wrapper's name is "<origin name cut to 25 bytes> (Rome)" and its symbol
///         "ro" + the origin's symbol cut to 8 bytes (RomeNaming), from the metadata the mint itself carries
///         (`add_spl_token_with_metadata`) or, for a mint made by the caller's own PDA, from the strings the
///         caller gives, put through the same rule (`add_spl_token_by_authority`).
///
/// @dev    Compared with ERC20SPLFactory (3.0.0, 9.0.0, which stay deployed and callable):
///           - `add_spl_token_no_metadata` is gone: no caller picks a name.
///           - There is no symbol table: `token_by_symbol_hash` and `mint_by_symbol_hash` are gone, and a symbol is
///             never an identity. Two origins may give one ro-symbol; the key is the mint.
///           - The metadata read fails closed (MintNameReader): a pointer to an account outside Token-2022 and
///             Metaplex is refused, a mint that asserts no name gets no wrapper, and so does a name or symbol that
///             RomeNaming refuses. Every check runs before the wrapper is deployed.
///           - `preview` answers what the add would, from the same function, without writing.
///           - A grandfather list, fixed at deploy: mints that already have a Rome token on this chain under an
///             old name. Nobody can make another token of one of them here. Its hash is keccak256(abi.encode(list))
///             and the list's entries are `(uint32 network, bytes32 mint, address wrapper)`, the preimage other tools that
///             take the same list use, so the hashes can be compared.
///         No owner, no upgrade, no setter. The name is read once, at registration, and a wrapper has no rename path.
///         It never consults another factory: a name taken in a legacy factory blocks nothing here.
contract ERC20SPLNamedFactory {
    enum WrapperKind {
        None,
        Cached,
        Token2022HookedCpi
    }

    /// @dev One entry of the grandfather list. Same layout as the list's entries in other tools that take it.
    struct GrandfatherEntry {
        uint32 network;
        bytes32 mint;
        address wrapper;
    }

    uint8 public constant DEFAULT_DECIMALS = 9;

    mapping(bytes32 => address) public token_by_mint;
    mapping(bytes32 => WrapperKind) public wrapper_kind_by_mint;
    mapping(address => uint64) public creator_nonce;
    /// @notice The wrapper a grandfathered mint already has, zero for any other mint.
    mapping(bytes32 => address) public grandfathered;

    /// @notice keccak256(abi.encode(list)) of the grandfather list given at deploy.
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

    /// @dev A mint already registered here.
    error AlreadyRegistered();
    /// @dev A mint on the grandfather list.
    error Grandfathered();
    /// @dev A mint whose metadata read fails or asserts no name.
    error NoName();
    /// @dev A name that RomeNaming refuses.
    error BadName();
    /// @dev A symbol that RomeNaming refuses.
    error BadSymbol();
    /// @dev A metadata pointer to an account that is neither the mint nor its own Metaplex account.
    error ExternalPointer();
    /// @dev The caller's PDA is not the mint's authority.
    error NotMintAuthority();
    /// @dev The authority path was used for a mint that asserts a name: it takes `add_spl_token_with_metadata`.
    error MintAssertsName();
    /// @dev A grandfather list with a zero mint, a zero wrapper or a repeated mint.
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

    // ----- registering -----

    /// @notice Registers an existing SPL mint and deploys its ERC-20 wrapper, named from the metadata the mint
    ///         carries: "<name cut to 25 bytes> (Rome)" and "ro" + the symbol cut to 8 bytes. Anyone may call.
    ///         A mint that asserts no name is refused: use `add_spl_token_by_authority` if you made it.
    function add_spl_token_with_metadata(bytes32 mint) public returns (address) {
        (string memory name, string memory symbol) = _fromMetadata(mint);
        return _register(mint, name, symbol);
    }

    /// @notice Registers a mint made by the caller's own PDA (`create_token_mint`) under the name and symbol the
    ///         caller gives, put through the same rule: "<originName cut to 25 bytes> (Rome)" and "ro" +
    ///         `originSymbol` cut to 8 bytes. Only the mint's own authority may call, and only for a mint that
    ///         asserts no name of its own. The strings are checked whole before the wrapper is deployed.
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

    /// @notice The two strings `add_spl_token_with_metadata(mint)` would give, from the same function, or the error
    ///         the add would raise, in the add's order. Writes nothing.
    function preview(bytes32 mint) external view returns (string memory name, string memory symbol) {
        return _fromMetadata(mint);
    }

    /// @dev The add's checks in their order: registered here, grandfathered, then the metadata read (an external
    ///      pointer, or no name), then the whole name, then the whole symbol.
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
        // Armed Transfer Hooks need a dynamic account tail and therefore use the dedicated direct-CPI wrapper.
        // Ordinary and present-but-unarmed mints get the cached wrapper (see ERC20SPLFactory, which this follows).
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

    // ----- mints made by the caller (unchanged from ERC20SPLFactory) -----

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
        bytes32 mintSeed =
            bytes32((uint256(uint32(bytes4("MINT"))) << 224) | (uint256(nonce) << 160) | uint160(address(this)));
        return (RomeEVMAccount.pda_with_salt(user, mintSeed), mintSeed);
    }

    function _assert_mint_account_missing(bytes32 mint) internal view {
        if (token_by_mint[mint] != address(0)) revert AlreadyRegistered();
        // Typed lamports-only probe via account_lamports: skips the full account_info decode.
        if (AccountReader.lamportsOf(mint) != 0) {
            revert MintAccountAlreadyExists(mint);
        }
    }

    /**
     * Creates and initializes a new SPL token mint atomically.
     * Token mint is derived from the creator's address and their current nonce, so each creator can create multiple tokens
     * by calling this function multiple times. The mint authority is the caller's own PDA: the caller then names the
     * token with `add_spl_token_by_authority`, or by giving the mint a name of its own.
     *
     * @return (bytes32 mint) Address of the created and initialized SPL Token mint.
     */
    function create_token_mint() external returns (bytes32) {
        (bytes32 mint, bytes32 mintSeed) = get_current_mint(msg.sender);
        _assert_mint_account_missing(mint);
        bytes32 user = HelperProgram.pda(msg.sender); // mint authority = caller's EXTERNAL_AUTHORITY PDA

        // System CreateAccount + SPL InitializeMint2 via HelperProgram.create_and_init_mint in a single dispatch: the
        // mint is never left created-but-uninitialized for a third party to initialize and seize authority over.
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

    /**
     * Backward-compatible no-op: create_token_mint creates and initializes atomically, so a legitimate mint reaching
     * here is already initialized. Reverts otherwise: it never initializes an arbitrary caller-supplied mint.
     */
    function init_token_mint(bytes32 mint) external view {
        // SPL Mint.is_initialized is a single bool byte at offset 45. Reading just that byte means an account too
        // small to hold it reverts on the read itself, so a never-created mint is rejected for free.
        bytes memory isInitialized = AccountReader.readBytesAt(mint, 45, 1);
        require(isInitialized[0] == 0x01, "mint not initialized; create_token_mint now initializes atomically");
    }
}
