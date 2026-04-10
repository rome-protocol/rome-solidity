// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {Convert} from "../convert.sol";
import "../rome_evm_account.sol";
import {ERC20SPLFactory} from "../erc20spl/erc20spl_factory.sol";
import {ERC20Users, SPL_ERC20} from "../erc20spl/erc20spl.sol";
import {SystemProgramLib} from "../system_program/system_program.sol";
import {AssociatedSplToken} from "../spl_token/associated_spl_token.sol";
import {MplTokenMetadataLib} from "../mpl_token_metadata/lib.sol";

library DAMMv1Lib {
    bytes32 public constant PROG_DYNAMIC_AMM =
    0xccf802d4cccc84d7fb21b5f73b49d81a16c5b4c88ee32394e1c91d3588cc4080; // Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB
    bytes32 public constant PROG_DYNAMIC_VAULT =
    0x0fbfe8846d685cbdc62cca7e04c7e8f68dcc313ab31277e2e0112a2ec0e052e5; // 24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi
    bytes32 internal constant DYNAMIC_VAULT_BASE_KEY =
    0xf569dfde202333598dc7d74b1d94b8624779c1f82f1e25a65b6e4ef8a3be9b9b; // HWzXGcGHy4tcpYfaRDCyLNzXqBTv3E6BttpCH2vJxArv

    uint256 internal constant POOL_PREFIX_MIN_LEN = 379;
    uint256 internal constant VAULT_MIN_LEN = 1197;
    uint64 internal constant DEFAULT_TRADE_FEE_BPS = 25;
    bytes internal constant DYNAMIC_VAULT_VAULT_PREFIX = "vault";
    bytes internal constant DYNAMIC_VAULT_TOKEN_VAULT_PREFIX = "token_vault";
    bytes internal constant DYNAMIC_VAULT_LP_MINT_PREFIX = "lp_mint";
    bytes internal constant DYNAMIC_AMM_LP_MINT_PREFIX = "lp_mint";
    bytes internal constant DYNAMIC_AMM_PROTOCOL_FEE_PREFIX = "fee";
    bytes internal constant DYNAMIC_AMM_CONFIG_PREFIX = "config";

    error InvalidVaultDataLength(uint256 actual, uint256 expected);
    error InvalidPoolDataLength(uint256 actual, uint256 expected);
    error InvalidPoolType(uint8 value);

    struct PoolFees {
        uint64 trade_fee_numerator;
        uint64 trade_fee_denominator;
        uint64 protocol_trade_fee_numerator;
        uint64 protocol_trade_fee_denominator;
    }

    enum PoolType {
        Permissioned,
        Permissionless
    }

    enum VaultOverrideNetwork {
        Mainnet,
        Devnet
    }

    enum CurveType {
        ConstantProduct,
        Stable
    }

    // DAMMv1 pool account state
    struct PoolState {
        bytes32 lp_mint;
        bytes32 token_a_mint;
        bytes32 token_b_mint;
        bytes32 a_vault;
        bytes32 b_vault;
        bytes32 a_vault_lp;
        bytes32 b_vault_lp;
        uint8 a_vault_lp_bump;
        bool enabled;
        bytes32 protocol_token_a_fee;
        bytes32 protocol_token_b_fee;
        uint64 fee_last_updated_at;
        PoolFees fees;
        PoolType pool_type;
    }

    struct VaultBumps {
        uint8 vault_bump;
        uint8 token_vault_bump;
    }

    struct LockedProfitTracker {
        uint64 last_updated_locked_profit;
        uint64 last_report;
        uint64 locked_profit_degradation;
    }

    struct VaultState {
        uint8 enabled;
        VaultBumps bumps;
        uint64 total_amount;
        bytes32 token_vault;
        bytes32 fee_vault;
        bytes32 token_mint;
        bytes32 lp_mint;
        LockedProfitTracker locked_profit_tracker;
    }

        // Helper structure used to prepare list of account for Swap instruction
    struct SwapAccountsInput {
        bytes32 pool;
        bytes32 user_source_token;
        bytes32 user_destination_token;
        bytes32 a_vault_lp;
        bytes32 b_vault_lp;
        bytes32 a_vault;
        bytes32 b_vault;
        bytes32 a_vault_lp_mint;
        bytes32 b_vault_lp_mint;
        bytes32 a_token_vault;
        bytes32 b_token_vault;
        bytes32 user;
        bytes32 vault_program;
        bytes32 token_program;
        bytes32 protocol_token_fee;
    }

    struct InitializeVaultAccounts {
        bytes32 vault;
        bytes32 payer;
        bytes32 token_vault;
        bytes32 token_mint;
        bytes32 lp_mint;
        bytes32 rent;
        bytes32 token_program;
        bytes32 system_program;
    }

    struct InitializePermissionlessPoolAccounts {
        bytes32 pool;
        bytes32 lp_mint;
        bytes32 token_a_mint;
        bytes32 token_b_mint;
        bytes32 a_vault;
        bytes32 b_vault;
        bytes32 a_token_vault;
        bytes32 b_token_vault;
        bytes32 a_vault_lp_mint;
        bytes32 b_vault_lp_mint;
        bytes32 a_vault_lp;
        bytes32 b_vault_lp;
        bytes32 payer_token_a;
        bytes32 payer_token_b;
        bytes32 payer_pool_lp;
        bytes32 protocol_token_a_fee;
        bytes32 protocol_token_b_fee;
        bytes32 payer;
        bytes32 fee_owner;
        bytes32 rent;
        bytes32 vault_program;
        bytes32 token_program;
        bytes32 associated_token_program;
        bytes32 system_program;
        bytes32 metadata_program;
        bytes32 mint_metadata;
    }

    struct InitializePermissionlessPoolConfig {
        CurveType curve_type;
        bytes32 token_a_mint;
        bytes32 token_b_mint;
        uint64 trade_fee_bps;
        uint64 token_a_amount;
        uint64 token_b_amount;
        bytes32 payer;
        bytes32 fee_owner;
        bytes32 dynamic_vault_program;
        bytes32 dynamic_amm_program;
        VaultOverrideNetwork override_network;
    }

    struct PermissionlessPoolDerivedKeys {
        bytes32 pool;
        bytes32 lp_mint;
        bytes32 a_vault;
        bytes32 b_vault;
        bytes32 a_token_vault;
        bytes32 b_token_vault;
        bytes32 a_vault_lp_mint;
        bytes32 b_vault_lp_mint;
        bytes32 a_vault_lp;
        bytes32 b_vault_lp;
        bytes32 protocol_token_a_fee;
        bytes32 protocol_token_b_fee;
        bytes32 mint_metadata;
    }

    struct InitializePermissionlessPoolWithConfigAccounts {
        bytes32 pool;
        bytes32 config;
        bytes32 lp_mint;
        bytes32 token_a_mint;
        bytes32 token_b_mint;
        bytes32 a_vault;
        bytes32 b_vault;
        bytes32 a_token_vault;
        bytes32 b_token_vault;
        bytes32 a_vault_lp_mint;
        bytes32 b_vault_lp_mint;
        bytes32 a_vault_lp;
        bytes32 b_vault_lp;
        bytes32 payer_token_a;
        bytes32 payer_token_b;
        bytes32 payer_pool_lp;
        bytes32 protocol_token_a_fee;
        bytes32 protocol_token_b_fee;
        bytes32 payer;
        bytes32 rent;
        bytes32 vault_program;
        bytes32 token_program;
        bytes32 associated_token_program;
        bytes32 system_program;
        bytes32 metadata_program;
        bytes32 mint_metadata;
    }

    struct InitializePermissionlessPoolWithConfigConfig {
        bytes32 token_a_mint;
        bytes32 token_b_mint;
        uint64 token_a_amount;
        uint64 token_b_amount;
        bytes32 payer;
        bytes32 config;
        bytes32 dynamic_vault_program;
        bytes32 dynamic_amm_program;
        VaultOverrideNetwork override_network;
    }

    struct PermissionlessPoolWithConfigDerivedKeys {
        bytes32 pool;
        bytes32 lp_mint;
        bytes32 a_vault;
        bytes32 b_vault;
        bytes32 a_token_vault;
        bytes32 b_token_vault;
        bytes32 a_vault_lp_mint;
        bytes32 b_vault_lp_mint;
        bytes32 a_vault_lp;
        bytes32 b_vault_lp;
        bytes32 protocol_token_a_fee;
        bytes32 protocol_token_b_fee;
        bytes32 mint_metadata;
    }

    // Parses DAMMv1 pool
    // @param data raw Solana account data
    // @return instance PoolState structure
    function parse_pool(bytes memory data) pure internal returns (PoolState memory p)
    {
        if (data.length < POOL_PREFIX_MIN_LEN) {
            revert InvalidPoolDataLength(data.length, POOL_PREFIX_MIN_LEN);
        }

        uint256 o = 8; // anchor discriminator

        (p.lp_mint, o) = Convert.read_bytes32(data, o);
        (p.token_a_mint, o) = Convert.read_bytes32(data, o);
        (p.token_b_mint, o) = Convert.read_bytes32(data, o);
        (p.a_vault, o) = Convert.read_bytes32(data, o);
        (p.b_vault, o) = Convert.read_bytes32(data, o);
        (p.a_vault_lp, o) = Convert.read_bytes32(data, o);
        (p.b_vault_lp, o) = Convert.read_bytes32(data, o);

        (p.a_vault_lp_bump, o) = Convert.read_u8(data, o);

        uint8 enabled_u8;
        (enabled_u8, o) = Convert.read_u8(data, o);
        p.enabled = enabled_u8 != 0;

        (p.protocol_token_a_fee, o) = Convert.read_bytes32(data, o);
        (p.protocol_token_b_fee, o) = Convert.read_bytes32(data, o);
        (p.fee_last_updated_at, o) = Convert.read_u64le(data, o);

        o += 24; // _padding0

        (p.fees.trade_fee_numerator, o) = Convert.read_u64le(data, o);
        (p.fees.trade_fee_denominator, o) = Convert.read_u64le(data, o);
        (p.fees.protocol_trade_fee_numerator, o) = Convert.read_u64le(data, o);
        (p.fees.protocol_trade_fee_denominator, o) = Convert.read_u64le(data, o);

        uint8 pool_type_u8;
        (pool_type_u8, o) = Convert.read_u8(data, o);
        if (pool_type_u8 > uint8(PoolType.Permissionless)) {
            revert InvalidPoolType(pool_type_u8);
        }
        p.pool_type = PoolType(pool_type_u8);

        return p;
    }

    function parse_vault(bytes memory data)
    internal
    pure
    returns (VaultState memory v)
    {
        if (data.length < VAULT_MIN_LEN) {
            revert InvalidVaultDataLength(data.length, VAULT_MIN_LEN);
        }

        uint256 o = 8; // anchor discriminator

        (v.enabled, o) = Convert.read_u8(data, o);
        (v.bumps.vault_bump, o) = Convert.read_u8(data, o);
        (v.bumps.token_vault_bump, o) = Convert.read_u8(data, o);

        (v.total_amount, o) = Convert.read_u64le(data, o);
        (v.token_vault, o) = Convert.read_bytes32(data, o);
        (v.fee_vault, o) = Convert.read_bytes32(data, o);
        (v.token_mint, o) = Convert.read_bytes32(data, o);
        (v.lp_mint, o) = Convert.read_bytes32(data, o);

        o += 32 * 30; // strategies[30]
        o += 32; // base
        o += 32; // admin
        o += 32; // operator

        (v.locked_profit_tracker.last_updated_locked_profit, o) = Convert.read_u64le(data, o);
        (v.locked_profit_tracker.last_report, o) = Convert.read_u64le(data, o);
        (v.locked_profit_tracker.locked_profit_degradation, o) = Convert.read_u64le(data, o);

        return v;
    }

    // Reads DAMMv1 pool account from Solana and parses it
    // @param pool_pubkey address of DAMMv1 Pool account in Solana
    // @return instance PoolState structure
    function load_pool(bytes32 pool_pubkey, address cpi_program)
    internal
    view
    returns (PoolState memory) {
        (,,,,, bytes memory data) = ICrossProgramInvocation(cpi_program).account_info(pool_pubkey);
        return parse_pool(data);
    }

    function load_vault(bytes32 vault_pubkey, address cpi_program)
    internal
    view
    returns (VaultState memory)
    {
        (,,,,, bytes memory data) = ICrossProgramInvocation(cpi_program).account_info(vault_pubkey);
        return parse_vault(data);
    }

    function derive_vault_key(bytes32 mint, bytes32 dynamic_vault_program)
    internal
    pure
    returns (bytes32)
    {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(DYNAMIC_VAULT_VAULT_PREFIX);
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(mint));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(DYNAMIC_VAULT_BASE_KEY));

        (bytes32 vaultKey,) = SystemProgram.find_program_address(dynamic_vault_program, seeds);
        return vaultKey;
    }

    function derive_config_key(uint64 index, bytes32 dynamic_amm_program)
    internal
    pure
    returns (bytes32)
    {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(DYNAMIC_AMM_CONFIG_PREFIX);
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(Convert.u64le(index)));

        (bytes32 configKey,) = SystemProgram.find_program_address(dynamic_amm_program, seeds);
        return configKey;
    }

    function derive_permissionless_constant_product_pool_with_config_key(
        bytes32 token_a_mint,
        bytes32 token_b_mint,
        bytes32 config,
        bytes32 dynamic_amm_program
    )
    internal
    pure
    returns (bytes32)
    {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(abi.encodePacked(get_first_key(token_a_mint, token_b_mint)));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(get_second_key(token_a_mint, token_b_mint)));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(config));

        (bytes32 poolKey,) = SystemProgram.find_program_address(dynamic_amm_program, seeds);
        return poolKey;
    }

    function derive_pool_lp_mint_key(bytes32 pool, bytes32 dynamic_amm_program)
    internal
    pure
    returns (bytes32)
    {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(DYNAMIC_AMM_LP_MINT_PREFIX);
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(pool));

        (bytes32 lpMintKey,) = SystemProgram.find_program_address(dynamic_amm_program, seeds);
        return lpMintKey;
    }

    function derive_vault_lp_key(bytes32 vault, bytes32 pool, bytes32 dynamic_amm_program)
    internal
    pure
    returns (bytes32)
    {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(abi.encodePacked(vault));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(pool));

        (bytes32 vaultLpKey,) = SystemProgram.find_program_address(dynamic_amm_program, seeds);
        return vaultLpKey;
    }

    function derive_protocol_fee_key(bytes32 token_mint, bytes32 pool, bytes32 dynamic_amm_program)
    internal
    pure
    returns (bytes32)
    {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(DYNAMIC_AMM_PROTOCOL_FEE_PREFIX);
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(token_mint));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(pool));

        (bytes32 protocolFeeKey,) = SystemProgram.find_program_address(dynamic_amm_program, seeds);
        return protocolFeeKey;
    }

    function derive_token_vault_key(bytes32 vault, bytes32 dynamic_vault_program)
    internal
    pure
    returns (bytes32)
    {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(DYNAMIC_VAULT_TOKEN_VAULT_PREFIX);
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(vault));

        (bytes32 tokenVaultKey,) = SystemProgram.find_program_address(dynamic_vault_program, seeds);
        return tokenVaultKey;
    }

    function derive_lp_mint_key(
        bytes32 vault,
        bytes32 dynamic_vault_program,
        VaultOverrideNetwork override_network
    )
    internal
    pure
    returns (bytes32)
    {
        bytes32 non_derived_based_lp_mint = lookup_non_pda_based_lp_mint(vault, override_network);
        if (non_derived_based_lp_mint != bytes32(0)) {
            return non_derived_based_lp_mint;
        }

        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(DYNAMIC_VAULT_LP_MINT_PREFIX);
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(vault));

        (bytes32 lpMintKey,) = SystemProgram.find_program_address(dynamic_vault_program, seeds);
        return lpMintKey;
    }

    function derive_initialize_vault_accounts(
        bytes32 token_mint,
        bytes32 payer,
        bytes32 dynamic_vault_program,
        VaultOverrideNetwork override_network
    )
    internal
    pure
    returns (InitializeVaultAccounts memory accounts_)
    {
        bytes32 vault = derive_vault_key(token_mint, dynamic_vault_program);

        accounts_ = InitializeVaultAccounts({
            vault: vault,
            payer: payer,
            token_vault: derive_token_vault_key(vault, dynamic_vault_program),
            token_mint: token_mint,
            lp_mint: derive_lp_mint_key(vault, dynamic_vault_program, override_network),
            rent: SystemProgramLib.RENT_ID,
            token_program: SplTokenLib.SPL_TOKEN_PROGRAM,
            system_program: SystemProgramLib.PROGRAM_ID
        });
    }

    function derive_initialize_permissionless_constant_product_pool_with_config_accounts(
        InitializePermissionlessPoolWithConfigConfig memory config
    )
    internal
    pure
    returns (InitializePermissionlessPoolWithConfigAccounts memory accounts_)
    {
        PermissionlessPoolWithConfigDerivedKeys memory derived = _derive_permissionless_pool_with_config_keys(config);

        accounts_.pool = derived.pool;
        accounts_.config = config.config;
        accounts_.lp_mint = derived.lp_mint;
        accounts_.token_a_mint = config.token_a_mint;
        accounts_.token_b_mint = config.token_b_mint;
        accounts_.a_vault = derived.a_vault;
        accounts_.b_vault = derived.b_vault;
        accounts_.a_token_vault = derived.a_token_vault;
        accounts_.b_token_vault = derived.b_token_vault;
        accounts_.a_vault_lp_mint = derived.a_vault_lp_mint;
        accounts_.b_vault_lp_mint = derived.b_vault_lp_mint;
        accounts_.a_vault_lp = derived.a_vault_lp;
        accounts_.b_vault_lp = derived.b_vault_lp;
        accounts_.payer_token_a = AssociatedSplToken.get_associated_token_address_with_program_id(
            config.payer,
            config.token_a_mint,
            SplTokenLib.SPL_TOKEN_PROGRAM,
            AssociatedSplToken.ASSOCIATED_TOKEN_PROGRAM_ID
        );
        accounts_.payer_token_b = AssociatedSplToken.get_associated_token_address_with_program_id(
            config.payer,
            config.token_b_mint,
            SplTokenLib.SPL_TOKEN_PROGRAM,
            AssociatedSplToken.ASSOCIATED_TOKEN_PROGRAM_ID
        );
        accounts_.payer_pool_lp = AssociatedSplToken.get_associated_token_address_with_program_id(
            config.payer,
            derived.lp_mint,
            SplTokenLib.SPL_TOKEN_PROGRAM,
            AssociatedSplToken.ASSOCIATED_TOKEN_PROGRAM_ID
        );
        accounts_.protocol_token_a_fee = derived.protocol_token_a_fee;
        accounts_.protocol_token_b_fee = derived.protocol_token_b_fee;
        accounts_.payer = config.payer;
        accounts_.rent = SystemProgramLib.RENT_ID;
        accounts_.vault_program = config.dynamic_vault_program;
        accounts_.token_program = SplTokenLib.SPL_TOKEN_PROGRAM;
        accounts_.associated_token_program = AssociatedSplToken.ASSOCIATED_TOKEN_PROGRAM_ID;
        accounts_.system_program = SystemProgramLib.PROGRAM_ID;
        accounts_.metadata_program = MplTokenMetadataLib.MPL_TOKEN_METADATA_PROGRAM_ID;
        accounts_.mint_metadata = derived.mint_metadata;
    }

    function _derive_permissionless_pool_with_config_keys(
        InitializePermissionlessPoolWithConfigConfig memory config
    )
    private
    pure
    returns (PermissionlessPoolWithConfigDerivedKeys memory derived)
    {
        derived.pool = derive_permissionless_constant_product_pool_with_config_key(
            config.token_a_mint,
            config.token_b_mint,
            config.config,
            config.dynamic_amm_program
        );
        derived.a_vault = derive_vault_key(config.token_a_mint, config.dynamic_vault_program);
        derived.b_vault = derive_vault_key(config.token_b_mint, config.dynamic_vault_program);
        derived.a_token_vault = derive_token_vault_key(derived.a_vault, config.dynamic_vault_program);
        derived.b_token_vault = derive_token_vault_key(derived.b_vault, config.dynamic_vault_program);
        derived.a_vault_lp_mint = derive_lp_mint_key(
            derived.a_vault,
            config.dynamic_vault_program,
            config.override_network
        );
        derived.b_vault_lp_mint = derive_lp_mint_key(
            derived.b_vault,
            config.dynamic_vault_program,
            config.override_network
        );
        derived.lp_mint = derive_pool_lp_mint_key(derived.pool, config.dynamic_amm_program);
        derived.a_vault_lp = derive_vault_lp_key(
            derived.a_vault,
            derived.pool,
            config.dynamic_amm_program
        );
        derived.b_vault_lp = derive_vault_lp_key(
            derived.b_vault,
            derived.pool,
            config.dynamic_amm_program
        );
        derived.protocol_token_a_fee = derive_protocol_fee_key(
            config.token_a_mint,
            derived.pool,
            config.dynamic_amm_program
        );
        derived.protocol_token_b_fee = derive_protocol_fee_key(
            config.token_b_mint,
            derived.pool,
            config.dynamic_amm_program
        );
        (derived.mint_metadata,) = MplTokenMetadataLib.find_metadata_pda(
            derived.lp_mint,
            MplTokenMetadataLib.MPL_TOKEN_METADATA_PROGRAM_ID
        );
    }

    function build_initialize_vault_instruction(
        InitializeVaultAccounts memory a,
        bytes32 dynamic_vault_program
    )
    internal
    pure
    returns (SystemProgramLib.Instruction memory ix)
    {
        ix.program_id = dynamic_vault_program;
        ix.accounts = build_initialize_vault_account_metas(a);
        ix.data = build_initialize_vault_ix_data();
    }


    function build_initialize_permissionless_constant_product_pool_with_config2_instruction(
        InitializePermissionlessPoolWithConfigAccounts memory a,
        uint64 token_a_amount,
        uint64 token_b_amount,
        bytes32 dynamic_amm_program
    )
    internal
    pure
    returns (SystemProgramLib.Instruction memory ix)
    {
        ix.program_id = dynamic_amm_program;
        ix.accounts = build_initialize_permissionless_constant_product_pool_with_config_account_metas(a);
        ix.data = build_initialize_permissionless_constant_product_pool_with_config2_ix_data(
            token_a_amount,
            token_b_amount
        );
    }

    function build_initialize_vault_account_metas(InitializeVaultAccounts memory a)
    internal
    pure
    returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        metas = new ICrossProgramInvocation.AccountMeta[](8);
        metas[0] = ICrossProgramInvocation.AccountMeta(a.vault, false, true);
        metas[1] = ICrossProgramInvocation.AccountMeta(a.payer, true, true);
        metas[2] = ICrossProgramInvocation.AccountMeta(a.token_vault, false, true);
        metas[3] = ICrossProgramInvocation.AccountMeta(a.token_mint, false, false);
        metas[4] = ICrossProgramInvocation.AccountMeta(a.lp_mint, false, true);
        metas[5] = ICrossProgramInvocation.AccountMeta(a.rent, false, false);
        metas[6] = ICrossProgramInvocation.AccountMeta(a.token_program, false, false);
        metas[7] = ICrossProgramInvocation.AccountMeta(a.system_program, false, false);
    }

    function build_initialize_vault_ix_data()
    internal
    pure
    returns (bytes memory)
    {
        return abi.encodePacked(bytes8(sha256(bytes("global:initialize"))));
    }

    function build_initialize_permissionless_constant_product_pool_with_config_account_metas(
        InitializePermissionlessPoolWithConfigAccounts memory a
    )
    internal
    pure
    returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        metas = new ICrossProgramInvocation.AccountMeta[](26);
        metas[0] = ICrossProgramInvocation.AccountMeta(a.pool, false, true);
        metas[1] = ICrossProgramInvocation.AccountMeta(a.config, false, false);
        metas[2] = ICrossProgramInvocation.AccountMeta(a.lp_mint, false, true);
        metas[3] = ICrossProgramInvocation.AccountMeta(a.token_a_mint, false, false);
        metas[4] = ICrossProgramInvocation.AccountMeta(a.token_b_mint, false, false);
        metas[5] = ICrossProgramInvocation.AccountMeta(a.a_vault, false, true);
        metas[6] = ICrossProgramInvocation.AccountMeta(a.b_vault, false, true);
        metas[7] = ICrossProgramInvocation.AccountMeta(a.a_token_vault, false, true);
        metas[8] = ICrossProgramInvocation.AccountMeta(a.b_token_vault, false, true);
        metas[9] = ICrossProgramInvocation.AccountMeta(a.a_vault_lp_mint, false, true);
        metas[10] = ICrossProgramInvocation.AccountMeta(a.b_vault_lp_mint, false, true);
        metas[11] = ICrossProgramInvocation.AccountMeta(a.a_vault_lp, false, true);
        metas[12] = ICrossProgramInvocation.AccountMeta(a.b_vault_lp, false, true);
        metas[13] = ICrossProgramInvocation.AccountMeta(a.payer_token_a, false, true);
        metas[14] = ICrossProgramInvocation.AccountMeta(a.payer_token_b, false, true);
        metas[15] = ICrossProgramInvocation.AccountMeta(a.payer_pool_lp, false, true);
        metas[16] = ICrossProgramInvocation.AccountMeta(a.protocol_token_a_fee, false, true);
        metas[17] = ICrossProgramInvocation.AccountMeta(a.protocol_token_b_fee, false, true);
        metas[18] = ICrossProgramInvocation.AccountMeta(a.payer, true, true);
        metas[19] = ICrossProgramInvocation.AccountMeta(a.rent, false, false);
        metas[20] = ICrossProgramInvocation.AccountMeta(a.mint_metadata, false, true);
        metas[21] = ICrossProgramInvocation.AccountMeta(a.metadata_program, false, false);
        metas[22] = ICrossProgramInvocation.AccountMeta(a.vault_program, false, false);
        metas[23] = ICrossProgramInvocation.AccountMeta(a.token_program, false, false);
        metas[24] = ICrossProgramInvocation.AccountMeta(a.associated_token_program, false, false);
        metas[25] = ICrossProgramInvocation.AccountMeta(a.system_program, false, false);
    }

    function build_initialize_permissionless_constant_product_pool_with_config2_ix_data(
        uint64 token_a_amount,
        uint64 token_b_amount
    )
    internal
    pure
    returns (bytes memory)
    {
        return abi.encodePacked(
            bytes8(sha256(bytes("global:initialize_permissionless_constant_product_pool_with_config2"))),
            Convert.u64le(token_a_amount),
            Convert.u64le(token_b_amount),
            uint8(0) // Option<u64>::None for activation_point
        );
    }

    function get_curve_type_bytes(CurveType curve_type)
    internal
    pure
    returns (bytes memory)
    {
        return abi.encodePacked(uint8(curve_type == CurveType.ConstantProduct ? 0 : 1));
    }

    function get_first_key(bytes32 token_a_mint, bytes32 token_b_mint)
    internal
    pure
    returns (bytes32)
    {
        return uint256(token_a_mint) > uint256(token_b_mint) ? token_a_mint : token_b_mint;
    }

    function get_second_key(bytes32 token_a_mint, bytes32 token_b_mint)
    internal
    pure
    returns (bytes32)
    {
        return uint256(token_a_mint) > uint256(token_b_mint) ? token_b_mint : token_a_mint;
    }

    function get_trade_fee_bps_bytes(uint64 trade_fee_bps)
    internal
    pure
    returns (bytes memory)
    {
        if (trade_fee_bps == DEFAULT_TRADE_FEE_BPS) {
            return bytes("");
        }

        return abi.encodePacked(Convert.u64le(trade_fee_bps));
    }

    function lookup_non_pda_based_lp_mint(bytes32 vault, VaultOverrideNetwork override_network)
    internal
    pure
    returns (bytes32)
    {
        if (override_network == VaultOverrideNetwork.Devnet) {
            return lookup_non_pda_based_lp_mint_devnet(vault);
        }

        return lookup_non_pda_based_lp_mint_mainnet(vault);
    }

    function lookup_non_pda_based_lp_mint_mainnet(bytes32 vault)
    internal
    pure
    returns (bytes32)
    {
        if (vault == 0x983ea73c317a5fd691bd2b3f19a3e23b6ba1652d898c15fbb010da925944dc2d) return 0x3e7bbb27b0fc7d689e0be8d710540b5292d10abb317eeab8d02cf2a4cf7bf702;
        if (vault == 0x948b3a136a9c978dd13171ccf112ba2a7dbd20ced5e2d97e628281542b738e37) return 0x7c1a5cd7617b51fa44b8788167de5686857877379ef8cc63d34047934543b4d6;
        if (vault == 0xe2d1c42533a7afd796067a6c076af65f01f849d3b8cc1896c7c62b96c707d326) return 0x35f174c1e6289a0b756ae98ba6b4f26513ad526bc4d2a68f9916bd181d1edd03;
        if (vault == 0xead3ffd164e7f73a2b61b5c3812f8dea76ff8339ad8c36d63a41db88cab416d5) return 0x9fffe6fd0c0ad672aae483067eb47237325c4b4e3c759dbad848b5f2ee36e170;
        if (vault == 0x4bd44319514e16bdf0990bb8e9a7a670297549c2639a999f2fd6e7ddf6800001) return 0x7c7f14872012ba046e65e945c341aab8500e8df5d7b869809c9ae0a7f936201c;
        if (vault == 0x1826bccf8efce0bfdd6069eaf85e36eb2b95952eba66d3e6ad3d5f28635998b2) return 0x8f9f2e1b7ed7e0e7ed834ba7d5644f7bd837b9e43c5596bc87b160cf127e2b46;
        if (vault == 0x9bd48879dbe2817e9d689e444035373e3449d23917f4f203089d103c31c5bb00) return 0xd3cc1eda8d06495adc0c57375f04231dadd82c30af8280e43907271db63b61e2;
        if (vault == 0x432b0a1f9d68038a747e26a6a83a5348e799b2e14b811c8cee0bdb00e9012097) return 0xc9963109f8909b3ca35001534d3fa75c8ae4942255b9c164aa220cfc7c4b4a2a;
        if (vault == 0x0b5f00045110363bfba9ca6bed530cd5c4592702830b43089441782937189ec6) return 0x3826ef984eb5b55bc3e6ec6ac5f98dddcbe8cf6b69a12bfde0174cca262413fc;
        if (vault == 0x740ca89675e5a15da7ccbc2572d26e715bea81fe457d1ac384e75ee2b4669f34) return 0x0f029976c29c2e9f2b89a1c0832d53e5961d9c194e8966794946bf5a0a36504a;
        if (vault == 0xa76b638b491a5d90979e2749adb0db8d4bf126b4388fd718132ed35e3edcdb81) return 0x10bb92f3f4ee9ee5fa8baadb4b4adeed946f351746f8a0d7fc3d8fa1a2f8f59f;
        if (vault == 0xd3742176b89c5e14c96b748998421f38101e09e5c59331b168b625cd2715bb26) return 0xd84e1290c198e788ba0e114f038214679608da28fcd20a1631efc393fbbf692a;
        if (vault == 0x2128b91cdeb1909ca90d852dedecca5b733a3816ca84e64b28a81a270dfd0dff) return 0x2412b8f35b076ddbface5f59862d529f46f66a1dd628d37b050f946734bde847;

        return bytes32(0);
    }

    function lookup_non_pda_based_lp_mint_devnet(bytes32 vault)
    internal
    pure
    returns (bytes32)
    {
        if (vault == 0x1c3809c7c083cb8cf8cb830e948e264039b45249101bb16bdcaa95bbabd6c8a9) return 0xb597a7b52e468c31723d1b4ee2e226b5230aa9707e97831e6a2f182f37ec2d03;
        if (vault == 0x0d0689cb4491a4bc4457f2190b52d6ee00f60296eb84ac9f9eff11a83566e1b9) return 0x24d05249cefb6683bae393083e79dc96b62a299884a5458884883686c7d7786b;
        if (vault == 0xe01cd03768a84cbe2f2a967d35b3dc6b802e1883acbd9edb9b4cedd25b95093b) return 0xa3930692ed460fd10d6ba0a83d0c2ade3eaa1968d417e835412e46df2ded17f6;
        if (vault == 0x12a0c9329b5bf995e1d4642054734a3e6367d76f0e415a06247d4ac1ab3ed043) return 0xbe9e98af1d7bc700f33c50f144337a535fb417ac05cc2788a0159c0f5f8eb856;
        if (vault == 0x8c8c93b41c3a6d4730c0707ff74a333d6b81218fb560e75a82484a5f33b4c35c) return 0x9eac0f60f777ee0fe1f244cb25efd78621e0a9106fd7d2f40d5053b0fc91c6df;
        if (vault == 0xd3742176b89c5e14c96b748998421f38101e09e5c59331b168b625cd2715bb26) return 0x02cca2aaece19457f1f3d1f73f1b86f47d7a17838b0b9ad4a00320a6829e30fe;
        if (vault == 0x740ca89675e5a15da7ccbc2572d26e715bea81fe457d1ac384e75ee2b4669f34) return 0x7001a581accf0a08c77b528e23d46f2e6af6c00852357744defe068abc755cdd;
        if (vault == 0x35ac52518afbe7485c4f4ad6a5c339898ebe06fb4d32ac79eec4c1efdaa6c36a) return 0x196e009889f4c769756a02d1e0df538eea88aa93b3768f61d5ad21a694c9bc9c;
        if (vault == 0x7ab4cc7f65219c0c82ed9a6a3fcf81a85df638d0299acb4ff447fdb742887d5f) return 0xa8e5e0f91ec83af7e8b0315995b31ab2b2c9ea963ca2a721aae0748f71f9a53f;
        if (vault == 0x9a4fc20963decd1ab7c5d34c3c01c1fd3e0b61dfed1ff7c45867c9c337a0108a) return 0x0d3b861351ac9bb496ea233569c774efef4d8e3ccad75350ad225f2f22422c1a;
        if (vault == 0xbabcd7961c5e0a60657a8c94e31549bfcc275136f944a21c9f78e411e48c32d6) return 0xe206c2d378d04a4c87fea8d3eaae21a3b7e79710397da50790fefc167a39f4d2;
        if (vault == 0xb1d3f5c9ed4d9351f4d4dcc82919352e694f998b538bf5d3f29873c4b1e5fdef) return 0xf3bdfc07b6a99dcec73ebcedf2726d41a6d0bc9987006d824d18117951179e8f;

        return bytes32(0);
    }

    function build_swap_account_metas(SwapAccountsInput memory a)
    internal
    pure
    returns (ICrossProgramInvocation.AccountMeta[] memory metas)
    {
        metas = new ICrossProgramInvocation.AccountMeta[](15);

        metas[0] = ICrossProgramInvocation.AccountMeta(a.pool, false, true);
        metas[1] = ICrossProgramInvocation.AccountMeta(
            a.user_source_token,
            false,
            true
        );
        metas[2] = ICrossProgramInvocation.AccountMeta(
            a.user_destination_token,
            false,
            true
        );
        metas[3] = ICrossProgramInvocation.AccountMeta(a.a_vault_lp, false, true);
        metas[4] = ICrossProgramInvocation.AccountMeta(a.b_vault_lp, false, true);
        metas[5] = ICrossProgramInvocation.AccountMeta(a.a_vault, false, true);
        metas[6] = ICrossProgramInvocation.AccountMeta(a.b_vault, false, true);
        metas[7] = ICrossProgramInvocation.AccountMeta(
            a.a_vault_lp_mint,
            false,
            true
        );
        metas[8] = ICrossProgramInvocation.AccountMeta(
            a.b_vault_lp_mint,
            false,
            true
        );
        metas[9] = ICrossProgramInvocation.AccountMeta(
            a.a_token_vault,
            false,
            true
        );
        metas[10] = ICrossProgramInvocation.AccountMeta(
            a.b_token_vault,
            false,
            true
        );
        metas[11] = ICrossProgramInvocation.AccountMeta(a.user, true, false);
        metas[12] = ICrossProgramInvocation.AccountMeta(
            a.vault_program,
            false,
            false
        );
        metas[13] = ICrossProgramInvocation.AccountMeta(
            a.token_program,
            false,
            false
        );
        metas[14] = ICrossProgramInvocation.AccountMeta(
            a.protocol_token_fee,
            false,
            true
        );
    }

    function build_swap_ix_data(uint64 in_amount, uint64 minimum_out_amount)
    internal
    pure
    returns (bytes memory)
    {
        bytes8 disc = bytes8(sha256(bytes("global:swap")));
        return abi.encodePacked(disc, Convert.u64le(in_amount), Convert.u64le(minimum_out_amount));
    }
}

contract DAMMv1Pool {
    enum PoolToken {
        TokenA,
        TokenB
    }

    struct Reserves {
        uint128 a_reserve;
        uint128 b_reserve;
    }

    error ZeroReserve();
    error DivisionByZero();

    address public immutable pool_factory;
    address public immutable token_factory;
    bool public initialized;

    bytes32 public pool_address;
    bytes32 public prog_dynamic_vault;
    bytes32 public prog_dynamic_amm;
    address public cpi_program;

    //////////////////////////////////////////////////////
    // Pool state (does not fit into stack as a structure)
    bytes32 public lp_mint;
    bytes32 public token_a_mint;
    bytes32 public token_b_mint;
    bytes32 public a_vault;
    bytes32 public b_vault;
    bytes32 public a_vault_lp;
    bytes32 public b_vault_lp;
    uint8 public a_vault_lp_bump;
    bool public enabled;
    bytes32 public protocol_token_a_fee;
    bytes32 public protocol_token_b_fee;
    uint64 public fee_last_updated_at;
    DAMMv1Lib.PoolFees public fees;
    DAMMv1Lib.PoolType public pool_type;
    //////////////////////////////////////////////////////

    DAMMv1Lib.VaultState public vault_a;
    DAMMv1Lib.VaultState public vault_b;

    constructor(address _token_factory) {
        pool_factory = msg.sender;
        token_factory = _token_factory;
    }

    modifier onlyFactory() {
        require(msg.sender == pool_factory, "FORBIDDEN");
        _;
    }

    function initialize(
        bytes32 _pool_address,
        bytes32 _prog_dynamic_vault,
        bytes32 _prog_dynamic_amm,
        address _cpi_program
    ) public onlyFactory {
        require(!initialized, "ALREADY_INITIALIZED");
        initialized = true;
        
        pool_address = _pool_address;
        prog_dynamic_vault = _prog_dynamic_vault;
        prog_dynamic_amm = _prog_dynamic_amm;
        cpi_program = _cpi_program;
        update_state();
    }

    function update_state() public {
        DAMMv1Lib.PoolState memory pool = DAMMv1Lib.load_pool(pool_address, cpi_program);
        update_pool_state(pool);
        vault_a = DAMMv1Lib.load_vault(a_vault, cpi_program);
        vault_b = DAMMv1Lib.load_vault(b_vault, cpi_program);
    }

    function update_pool_state(DAMMv1Lib.PoolState memory pool) internal
    {
        lp_mint = pool.lp_mint;
        token_a_mint = pool.token_a_mint;
        token_b_mint = pool.token_b_mint;
        a_vault = pool.a_vault;
        b_vault = pool.b_vault;
        a_vault_lp = pool.a_vault_lp;
        b_vault_lp = pool.b_vault_lp;
        a_vault_lp_bump = pool.a_vault_lp_bump;
        enabled = pool.enabled;
        protocol_token_a_fee = pool.protocol_token_a_fee;
        protocol_token_b_fee = pool.protocol_token_b_fee;
        fee_last_updated_at = pool.fee_last_updated_at;
        fees = pool.fees;
        pool_type = pool.pool_type;
    }

    function get_reserves()
    public
    view
    returns (Reserves memory r)
    {
        DAMMv1Lib.VaultState memory vault_a_state = DAMMv1Lib.load_vault(a_vault, cpi_program);
        DAMMv1Lib.VaultState memory vault_b_state = DAMMv1Lib.load_vault(b_vault, cpi_program);

        SplTokenLib.SplMint memory a_lp_mint = SplTokenLib.load_mint(vault_a_state.lp_mint, cpi_program);
        SplTokenLib.SplMint memory b_lp_mint = SplTokenLib.load_mint(vault_b_state.lp_mint, cpi_program);

        uint64 pool_lp_a = SplTokenLib.load_token_amount(a_vault_lp, cpi_program);
        uint64 pool_lp_b = SplTokenLib.load_token_amount(b_vault_lp, cpi_program);

        uint128 a_reserve = a_lp_mint.supply == 0
            ? 0
            : uint128(pool_lp_a) * uint128(vault_a_state.total_amount)
            / uint128(a_lp_mint.supply);

        uint128 b_reserve = b_lp_mint.supply == 0
            ? 0
            : uint128(pool_lp_b) * uint128(vault_b_state.total_amount)
            / uint128(b_lp_mint.supply);

        r = Reserves({a_reserve: a_reserve, b_reserve: b_reserve});
    }

    function get_price_e18(PoolToken token)
    external
    view
    returns (uint256)
    {
        Reserves memory r = get_reserves();
        SplTokenLib.SplMint memory mint_a = SplTokenLib.load_mint(token_a_mint, cpi_program);
        SplTokenLib.SplMint memory mint_b = SplTokenLib.load_mint(token_b_mint, cpi_program);

        if (token == PoolToken.TokenA) {
            if (r.a_reserve == 0) revert ZeroReserve();

            return uint256(r.b_reserve)
                * (10 ** uint256(mint_a.decimals))
                * 1e18
                / uint256(r.a_reserve)
                / (10 ** uint256(mint_b.decimals));
        } else {
            if (r.b_reserve == 0) revert ZeroReserve();

            return uint256(r.a_reserve)
                * (10 ** uint256(mint_b.decimals))
                * 1e18
                / uint256(r.b_reserve)
                / (10 ** uint256(mint_a.decimals));
        }
    }

    function get_fees_e18()
    external
    view
    returns (uint256)
    {
        if (
            fees.trade_fee_denominator == 0
            || fees.protocol_trade_fee_denominator == 0
        ) {
            revert DivisionByZero();
        }

        uint256 lp_fee_e18 = uint256(fees.trade_fee_numerator) * 1e18
            / uint256(fees.trade_fee_denominator);

        uint256 protocol_fee_e18 =
            uint256(fees.protocol_trade_fee_numerator) * 1e18
            / uint256(fees.protocol_trade_fee_denominator);

        return lp_fee_e18 * (1e18 + protocol_fee_e18) / 1e18;
    }

    function make_swap_accounts_from_pool(
        bytes32 user_source_token_account,
        bytes32 user_destination_token_account,
        bytes32 user,
        PoolToken in_token
    ) internal view returns (DAMMv1Lib.SwapAccountsInput memory out) {
        bytes32 protocol_token_fee = in_token == PoolToken.TokenA
            ? protocol_token_a_fee
            : protocol_token_b_fee;

        out = DAMMv1Lib.SwapAccountsInput({
            pool: pool_address,
            user_source_token: user_source_token_account,
            user_destination_token: user_destination_token_account,
            a_vault_lp: a_vault_lp,
            b_vault_lp: b_vault_lp,
            a_vault: a_vault,
            b_vault: b_vault,
            a_vault_lp_mint: vault_a.lp_mint,
            b_vault_lp_mint: vault_b.lp_mint,
            a_token_vault: vault_a.token_vault,
            b_token_vault: vault_b.token_vault,
            user: user,
            vault_program: prog_dynamic_vault,
            token_program: SplTokenLib.SPL_TOKEN_PROGRAM,
            protocol_token_fee: protocol_token_fee
        });
    }

    function invoke_swap(
        DAMMv1Lib.SwapAccountsInput memory a,
        uint64 in_amount,
        uint64 minimum_out_amount
    ) internal {
        ICrossProgramInvocation.AccountMeta[] memory accounts = DAMMv1Lib.build_swap_account_metas(a);
        bytes memory data = DAMMv1Lib.build_swap_ix_data(in_amount, minimum_out_amount);

        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke(bytes32,(bytes32,bool,bool)[],bytes)",
                prog_dynamic_amm,
                accounts,
                data
            )
        );

        require(success, string(result));
    }

    function invoke_swap(
        bytes32 user_source_token_account,
        bytes32 user_destination_token_account,
        bytes32 user,
        PoolToken in_token,
        uint64 in_amount,
        uint64 minimum_out_amount
    ) external {
        DAMMv1Lib.SwapAccountsInput memory a = make_swap_accounts_from_pool(
            user_source_token_account,
            user_destination_token_account,
            user,
            in_token
        );

        invoke_swap(a, in_amount, minimum_out_amount);
    }
}

contract ERC20DAMMv1Pool {
    DAMMv1Pool private immutable internal_pool;
    ERC20Users private immutable users;
    SPL_ERC20 private immutable tokenA;
    SPL_ERC20 private immutable tokenB;

    constructor(
        DAMMv1Pool _internal_pool,
        ERC20SPLFactory token_factory
    ) {
        tokenA = SPL_ERC20(token_factory.token_by_mint(_internal_pool.token_a_mint()));
        tokenB = SPL_ERC20(token_factory.token_by_mint(_internal_pool.token_b_mint()));
        internal_pool = _internal_pool;
        users = token_factory.users();
    }

    function update_state() external {
        internal_pool.update_state();
    }

    function get_reserves() external view returns (DAMMv1Pool.Reserves memory) {
        return internal_pool.get_reserves();
    }

    function get_price_e18(DAMMv1Pool.PoolToken token)
    external
    view
    returns (uint256)    {
        return internal_pool.get_price_e18(token);
    }

    function get_fees_e18() external view returns (uint256) {
        return internal_pool.get_fees_e18();
    }

    function swapExactTokensForTokens(
        address token_in,
        uint256 amount_in,
        uint256 min_amount_out
    ) external {
        bytes32 tokenA_account = tokenA.get_token_account(msg.sender);
        bytes32 tokenB_account = tokenB.get_token_account(msg.sender);
        bytes32 user = users.get_user(msg.sender);

        DAMMv1Pool.PoolToken in_token = DAMMv1Pool.PoolToken.TokenA;
        bytes32 source_account = tokenA_account;
        bytes32 destination_account = tokenB_account;

        if (address(tokenB) == token_in) {
            in_token = DAMMv1Pool.PoolToken.TokenB;
            source_account = tokenB_account;
            destination_account = tokenA_account;
        }

        require(amount_in <= type(uint64).max, "amount_in exceeds uint64");
        require(min_amount_out <= type(uint64).max, "min_amount_out exceeds uint64");

        (bool success, bytes memory result) = address(internal_pool).delegatecall(
            abi.encodeWithSignature(
                "invoke_swap(bytes32,bytes32,bytes32,uint8,uint64,uint64)",
                source_account,
                destination_account,
                user,
                uint8(in_token),
                uint64(amount_in),
                uint64(min_amount_out)
            )
        );

        require(success, string(Convert.revert_msg(result)));
    }
}
