// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20Users} from "./erc20spl.sol";
import {SPL_ERC20_cached} from "./erc20spl_cached.sol";
import {MplTokenMetadataLib} from "../mpl_token_metadata/lib.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {SystemProgramLib} from "../system_program/system_program.sol";
import {ICrossProgramInvocation, ISystemProgram, SystemProgram, HelperProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {Convert} from "../convert.sol";
import {AccountReader} from "../cpi/AccountReader.sol";

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

    // Token-2022 tier gate (D8, armed-keyed). The program classifies via
    // HelperProgram.wrap_allowed; this factory holds the enablement policy —
    // a bitmask over tiers 0..4 (bit N = tier N) — so tiers flip with an
    // admin tx, not a program upgrade or redeploy. TokenCreated stays
    // untouched (indexer-stable); the tier record is the NEW event below.
    event TokenTierRecorded(bytes32 indexed mint, address indexed wrapper, uint8 tier, uint16 feeBps);

    error MintAccountAlreadyExists(bytes32 mint);
    error MintRejected(bytes32 mint);
    error TierNotEnabled(bytes32 mint, uint8 tier);
    error NotGateAdmin(address caller);

    uint8 internal constant TIER_REJECTED = 255;
    // bit0 legacy + bit1 benign. The factory's own create_token_mint path
    // makes plain legacy mints, so bit0 must stay on.
    uint8 public constant DEFAULT_ENABLED_TIERS = 0x03;

    address public immutable gate_admin;
    uint8 public enabled_tiers;

    constructor(address _cpi_program) {
        cpi_program = _cpi_program;
        mpl_token_metadata_program = SystemProgram.base58_to_bytes32(bytes(METAPLEX_TOKEN_METADATA_PROGRAM_NAME));
        users = new ERC20Users();
        gate_admin = msg.sender;
        enabled_tiers = DEFAULT_ENABLED_TIERS;
    }

    function set_enabled_tiers(uint8 mask) external {
        if (msg.sender != gate_admin) {
            revert NotGateAdmin(msg.sender);
        }
        enabled_tiers = mask;
    }

    function _check_symbol_hash_exists(bytes32 symbolHash) internal view {
        require(token_by_symbol_hash[symbolHash] == address(0), "Token with symbol exists");
        require(mint_by_symbol_hash[symbolHash] == bytes32(0), "Token with symbol exists");
    }

    function _register_contract(bytes32 mint, string memory name, string memory symbol) internal returns(address) {
        bytes32 symbolHash = keccak256(bytes(symbol));
        _check_symbol_hash_exists(symbolHash);

        (uint8 tier, uint16 feeBps) = HelperProgram.wrap_allowed(mint);
        if (tier == TIER_REJECTED) {
            revert MintRejected(mint);
        }
        if (enabled_tiers & (uint8(1) << tier) == 0) {
            revert TierNotEnabled(mint, tier);
        }

        // Deploy the cache-track wrapper. `SPL_ERC20_cached` exposes the
        // identical IERC20 + IERC20Metadata surface as the prior
        // `SPL_ERC20`, but dispatches every mutating SPL operation
        // through `SplCached` / `AssociatedSplCached` (0xff..05 / 06).
        // Net effects vs the legacy CPI-track wrapper:
        //   - Iterative-VM compatible (cached SPL ops don't trip the
        //     legacy CpiProhibitedInIterativeTx gate), so multi-step
        //     flows like Compound's Bulker and multi-hop swaps compose.
        //   - EVM-revert atomicity over the Solana-side SPL side
        //     effects (committed only at end-of-tx via the cache).
        //   - 2–10% CU reduction on most ops (see rome-solidity #210
        //     bench).
        // Constructor signature is identical, so the factory's
        // ABI / event surface is unchanged.
        SPL_ERC20_cached new_contract = new SPL_ERC20_cached(mint, cpi_program, name, symbol, users);
        token_by_mint[mint] = address(new_contract);
        mint_by_symbol_hash[symbolHash] = mint;
        token_by_symbol_hash[symbolHash] = address(new_contract);

        emit TokenCreated(msg.sender, mint, address(new_contract), name, symbol, creator_nonce[msg.sender]);
        emit TokenTierRecorded(mint, address(new_contract), tier, feeBps);
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

    function _assert_mint_account_missing(bytes32 mint) internal view {
        require(token_by_mint[mint] == address(0), "Token exists");
        // Typed lamports-only probe via account_lamports (selector 0xde79ed54)
        // — skips the full account_info 6-tuple decode + 82-byte data buffer.
        // Saves ~15-30K CU per create_token_mint call (Agent 2/4 audit, 2026-05-16).
        if (AccountReader.lamportsOf(mint) != 0) {
            revert MintAccountAlreadyExists(mint);
        }
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
        (bytes32 mint, bytes32 mintSeed) = get_current_mint(msg.sender);
        _assert_mint_account_missing(mint);

        // System CreateAccount via HelperProgram.create_mint_account (selector
        // 0xe97d3291, shipped in a Rome EVM program upgrade). Allocates the
        // salt-derived mint PDA with space=82 (SPL_MINT_LEN), owner=SPL Token,
        // lamports=rent-floor for 82 bytes — all hardcoded inside the precompile.
        // Funder = caller's external_auth PDA; new account = external_auth_with_salt
        // (caller, mintSeed). Two PDA signers handled internally. Replaces the
        // prior SystemProgramLib.create_account + invoke_signed marshaling path
        // — saves ~30-50K EVM CU per call.
        //
        // The new mint address is deterministic from (caller, mintSeed); we
        // return the client-computed `mint` value (same bytes32 that
        // get_current_mint derived above).
        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_mint_account(bytes32)",
                mintSeed
            )
        );
        require(success, string(Convert.revert_msg(result)));

        uint64 nonce = creator_nonce[msg.sender];
        creator_nonce[msg.sender] = nonce + 1;
        return mint;
    }

    /**
     * Initializes previously created mint account.
     */
    function init_token_mint(bytes32 mint) external {
        // Mint authority = caller's external_auth PDA. Stored in the mint
        // account as data — NOT a runtime signer for InitializeMint2.
        bytes32 user = HelperProgram.pda(msg.sender);

        // SPL Token InitializeMint2 via HelperProgram.init_spl_mint
        // (selector 0x4f75e987, shipped in a Rome EVM program upgrade).
        // No PDA signer needed (mint_authority + freeze_authority are stored
        // as account data, not runtime signers). Replaces the prior
        // SplTokenLib.initialize_mint + invoke marshaling path — saves
        // ~30-50K EVM CU per call.
        //
        // has_freeze_authority = false → freeze_authority arg is ignored
        // (pass bytes32(0) for explicitness; the COption tag inside the
        // precompile is what controls the SPL ix encoding).
        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "init_spl_mint(bytes32,uint8,bytes32,bool,bytes32)",
                mint,
                DEFAULT_DECIMALS,
                user,
                false,
                bytes32(0)
            )
        );
        require(success, string(Convert.revert_msg(result)));
    }
}
