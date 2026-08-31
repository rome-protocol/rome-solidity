// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20Users} from "./erc20spl.sol";
import {SPL_ERC20_cached} from "./erc20spl_cached.sol";
import {ERC20SPLHookedDeployer} from "./erc20spl_hooked_deployer.sol";
import {MplTokenMetadataLib} from "../mpl_token_metadata/lib.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {SystemProgramLib} from "../system_program/system_program.sol";
import {ICrossProgramInvocation, ISystemProgram, SystemProgram, HelperProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {AccountReader} from "../cpi/AccountReader.sol";

contract ERC20SPLFactory {
    enum WrapperKind {
        None,
        Cached,
        Token2022HookedCpi
    }
    uint8 public constant DEFAULT_DECIMALS = 9;
    uint64 internal constant SPL_MINT_LEN = 82;
    string internal constant METAPLEX_TOKEN_METADATA_PROGRAM_NAME = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

    mapping(bytes32 => address) public token_by_mint;
    mapping(bytes32 => WrapperKind) public wrapper_kind_by_mint;
    mapping(bytes32 => bytes32) public mint_by_symbol_hash;
    mapping(bytes32 => address) public token_by_symbol_hash;
    mapping(address => uint64) public creator_nonce;

    bytes32 public immutable mpl_token_metadata_program;
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

    constructor(address _cpi_program) {
        cpi_program = _cpi_program;
        mpl_token_metadata_program = SystemProgram.base58_to_bytes32(bytes(METAPLEX_TOKEN_METADATA_PROGRAM_NAME));
        users = new ERC20Users();
        hooked_wrapper_deployer = new ERC20SPLHookedDeployer();
    }

    function _check_symbol_hash_exists(bytes32 symbolHash) internal view {
        require(token_by_symbol_hash[symbolHash] == address(0), "Token with symbol exists");
        require(mint_by_symbol_hash[symbolHash] == bytes32(0), "Token with symbol exists");
    }

    function _register_contract(bytes32 mint, string memory name, string memory symbol) internal returns(address) {
        bytes32 symbolHash = keccak256(bytes(symbol));
        _check_symbol_hash_exists(symbolHash);

        // Armed Transfer Hooks need a dynamic account tail and therefore use
        // the dedicated direct-CPI wrapper. Ordinary and present-but-unarmed
        // mints retain the cached wrapper. The two existing fixed-account
        // wrappers continue to reject armed hooks in their own constructors.
        (, , bytes32 hook_program, ,) = HelperProgram.mint_info(mint);
        address wrapper;
        if (hook_program != bytes32(0)) {
            wrapper = hooked_wrapper_deployer.deploy(
                mint, cpi_program, name, symbol, users
            );
            wrapper_kind_by_mint[mint] = WrapperKind.Token2022HookedCpi;
        } else {
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
            SPL_ERC20_cached cached = new SPL_ERC20_cached(
                mint, cpi_program, name, symbol, users
            );
            wrapper = address(cached);
            wrapper_kind_by_mint[mint] = WrapperKind.Cached;
        }
        token_by_mint[mint] = wrapper;
        mint_by_symbol_hash[symbolHash] = mint;
        token_by_symbol_hash[symbolHash] = wrapper;

        emit TokenCreated(msg.sender, mint, wrapper, name, symbol, creator_nonce[msg.sender]);
        return wrapper;
    }

    /**
     * Registers existing SPL token and deploys ERC20 wrapper for it. 
     * Name and symbol are loaded from the token's metadata account, 
     * so the token must have metadata already created on Solana for this function to work. 
     * If the token does not have metadata or if the metadata is missing name or symbol, 
     * this function will revert. Symbol must be unique across all tokens created through this factory.
     * @param mint SPL token mint address
     */
    /// The identity the mint itself asserts, if it asserts one.
    ///
    /// A Token-2022 mint can carry its name and symbol inside the mint account,
    /// under the mint's own metadata authority — MetadataPointer alongside
    /// TokenMetadata. That is where 2022 tokens put it, and it is checked first
    /// because it is the source closest to the mint. Metaplex stays the fallback,
    /// and is what legacy SPL mints use.
    ///
    /// Deliberately not read: a MetadataPointer aimed at a SEPARATE account. Such a
    /// mint falls through to the Metaplex attempt, which is exactly today's
    /// behaviour — the self-referential shape is what real mints use, and it is the
    /// one verified against actual mint bytes.
    function _mint_identity(bytes32 mint)
    internal
    view
    returns (bool, string memory, string memory) {
        (uint64 lamports, , , , , bytes memory data) =
            ICrossProgramInvocation(cpi_program).account_info(mint);
        if (lamports != 0) {
            (bool has_pointer, bytes32 where) = SplTokenLib.metadata_pointer(data);
            if (has_pointer && where == mint) {
                (bool ok, string memory n, string memory sym) = SplTokenLib.token_metadata(data);
                if (ok) {
                    return (true, n, sym);
                }
            }
        }

        (bool metadata_exists, MplTokenMetadataLib.Metadata memory metadata) = MplTokenMetadataLib.load_metadata(
            mint, mpl_token_metadata_program, cpi_program
        );
        if (metadata_exists) {
            return (true, metadata.name, metadata.symbol);
        }
        return (false, "", "");
    }

    function add_spl_token_with_metadata(bytes32 mint)
    public
    returns (address) {
        require(token_by_mint[mint] == address(0), "Token exists");

        (bool found, string memory name, string memory symbol) = _mint_identity(mint);
        // Says which condition failed. The old message claimed no metadata existed,
        // which was untrue of any Token-2022 mint carrying it natively — the mint
        // had it, in a place this function did not look.
        require(found, "Mint asserts no name: use add_spl_token_no_metadata");
        return _register_contract(mint, name, symbol);
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

    /// The rome-evm DELEGATECALL identity gate (Halborn #511,
    /// owner_authenticated := context.address == code_address) rejects this
    /// call's old form outright, and there is no gate-safe replacement a
    /// contract can make on its behalf: a direct CALL passes the gate but
    /// rebinds context.caller to this factory instead of the creator, which
    /// would corrupt both the salt-derived mint PDA (get_current_mint is
    /// keyed by the creator, not the factory) and the rent payer (must be
    /// the creator's own EXTERNAL_AUTHORITY PDA, not an unfunded factory
    /// PDA). Both properties require context.caller == the actual creator,
    /// which only a user-direct call preserves.
    error CreateTokenMintMovedOffFactory();

    /**
     * REMOVED as an on-chain-creating entrypoint — see CreateTokenMintMovedOffFactory.
     * The create step is now user-direct: call
     * HelperProgram.create_and_init_mint(DEFAULT_DECIMALS, HelperProgram.pda(msg.sender),
     * false, bytes32(0), <mintSeed from get_current_mint(msg.sender)>) straight from the
     * creator's own tx (atomic create+init, same one dispatch as before — the #326
     * front-run fix lives in that atomicity, not in who calls it). Then register the
     * result with add_spl_token_no_metadata / add_spl_token_with_metadata as before.
     * get_current_mint(user) still predicts the same salt-derived address, and the
     * on-chain mint authority is still the creator's own PDA — unchanged.
     */
    function create_token_mint() external pure returns (bytes32) {
        revert CreateTokenMintMovedOffFactory();
    }

    /**
     * Advances the caller's nonce after a user-direct create (see create_token_mint's
     * NatSpec), so get_current_mint(msg.sender) next predicts a fresh salt instead of
     * re-deriving the mint just created. Requires `mint` to be exactly the caller's
     * current predicted mint (get_current_mint) AND already initialized on-chain —
     * this only ever advances the CALLER's own nonce for the CALLER's own next
     * self-created mint, so it is not front-runnable: a third party's call checks
     * their own (different) predicted mint and simply does not match. Optional —
     * only needed before creating a second mint; registering (add_spl_token_*) does
     * not require it.
     */
    function confirm_created_mint(bytes32 mint) external {
        (bytes32 predicted, ) = get_current_mint(msg.sender);
        require(predicted == mint, "not caller's predicted mint");
        bytes memory isInitialized = AccountReader.readBytesAt(mint, 45, 1);
        require(isInitialized[0] == 0x01, "mint not initialized");
        creator_nonce[msg.sender] = creator_nonce[msg.sender] + 1;
    }

    /**
     * Backward-compatible no-op: the mint reaching here was created and initialized
     * atomically by the creator's own direct HelperProgram.create_and_init_mint call
     * (see create_token_mint's NatSpec), so a legitimate mint is already initialized.
     * Reverts otherwise — this never initializes an arbitrary caller-supplied mint.
     */
    function init_token_mint(bytes32 mint) external view {
        // SPL Mint.is_initialized is a single bool byte at offset 45. Reading just that
        // byte (rather than the full 82-byte account) means an account too small to hold
        // it reverts on the read itself, so a never-created mint is rejected for free.
        bytes memory isInitialized = AccountReader.readBytesAt(mint, 45, 1);
        require(isInitialized[0] == 0x01, "mint not initialized; create_token_mint now initializes atomically");
    }
}
