// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DAMMv1Lib, DAMMv1Pool, ERC20DAMMv1Pool} from "./damm_v1_pool.sol";
import {ERC20SPLFactory} from "../erc20spl/erc20spl_factory.sol";
import {ERC20Users} from "../erc20spl/erc20spl.sol";
import {ICrossProgramInvocation} from "../interface.sol";
import {SystemProgramLib} from "../system_program/system_program.sol";
import {Convert} from "../convert.sol";

contract MeteoraDAMMv1Factory {
    ERC20SPLFactory public immutable token_factory;
    mapping(address => mapping(address => address)) public getPool; // token0 => token1 => pool
    address[] public allPools;

    event PoolAdded(
        address indexed token0,
        address indexed token1,
        address pair,
        uint
    );

    bytes32 public prog_dynamic_vault;
    bytes32 public prog_dynamic_amm;
    address public cpi_program;
    DAMMv1Lib.VaultOverrideNetwork public vault_override_network;

    constructor(
        ERC20SPLFactory _token_factory,
        bytes32 _prog_dynamic_vault,
        bytes32 _prog_dynamic_amm,
        address _cpi_program,
        DAMMv1Lib.VaultOverrideNetwork _vault_override_network
    ) {
        token_factory = _token_factory;
        prog_dynamic_vault = _prog_dynamic_vault;
        prog_dynamic_amm = _prog_dynamic_amm;
        cpi_program = _cpi_program;
        vault_override_network = _vault_override_network;
    }

    function allPoolsLength() external view returns (uint) {
        return allPools.length;
    }

    function deriveConfigKey(uint64 index) public view returns (bytes32) {
        return DAMMv1Lib.derive_config_key(index, prog_dynamic_amm);
    }

    function derivePermissionlessConstantProductPoolWithConfigKey(
        bytes32 token_a_mint,
        bytes32 token_b_mint,
        bytes32 config
    )
    public
    view
    returns (bytes32)
    {
        return DAMMv1Lib.derive_permissionless_constant_product_pool_with_config_key(
            token_a_mint,
            token_b_mint,
            config,
            prog_dynamic_amm
        );
    }

    function orderTokens(address tokenA, address tokenB) public pure returns (address token0, address token1) {
        (token0, token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        return (token0, token1);
    }

    function previewInitializeVault(bytes32 token_mint, address user)
    external
    view
    returns (
        bool should_initialize,
        DAMMv1Lib.InitializeVaultAccounts memory accounts_
    ) {
        bytes32 payer = ERC20Users(token_factory.users()).get_user(user);
        accounts_ = DAMMv1Lib.derive_initialize_vault_accounts(
            token_mint,
            payer,
            prog_dynamic_vault,
            vault_override_network
        );
        should_initialize = _account_missing(accounts_.vault);
    }

    function initializeVaultIfMissing(bytes32 token_mint) external returns (bytes32 vault, bool initialized_) {
        bytes32 payer = token_factory.users().get_user(msg.sender);
        DAMMv1Lib.InitializeVaultAccounts memory accounts_ = DAMMv1Lib.derive_initialize_vault_accounts(
            token_mint,
            payer,
            prog_dynamic_vault,
            vault_override_network
        );

        vault = accounts_.vault;
        if (!_account_missing(vault)) {
            return (vault, false);
        }

        SystemProgramLib.Instruction memory ix = DAMMv1Lib.build_initialize_vault_instruction(
            accounts_,
            prog_dynamic_vault
        );
        _invoke_signed(ix, token_factory.users().payer_salt());
        return (vault, true);
    }

    function preparePermissionlessConstantProductPoolWithConfig2(
        bytes32 token_a_mint,
        bytes32 token_b_mint,
        bytes32 config
    )
    external
    view
    returns (DAMMv1Lib.InitializePermissionlessPoolWithConfigAccounts memory accounts_)
    {
        DAMMv1Lib.InitializePermissionlessPoolWithConfigConfig memory pool_config =
                            DAMMv1Lib.InitializePermissionlessPoolWithConfigConfig({
                token_a_mint: token_a_mint,
                token_b_mint: token_b_mint,
                payer: ERC20Users(token_factory.users()).get_user(msg.sender),
                config: config,
                dynamic_vault_program: prog_dynamic_vault,
                dynamic_amm_program: prog_dynamic_amm,
                override_network: vault_override_network
            });

        accounts_ = DAMMv1Lib.derive_initialize_permissionless_constant_product_pool_with_config_accounts(pool_config);
    }

    function createPermissionlessConstantProductPoolWithConfig2(
        uint64 token_a_amount,
        uint64 token_b_amount,
        DAMMv1Lib.InitializePermissionlessPoolWithConfigAccounts memory accounts
    ) external returns (bytes32 pool_pubkey) {
        require(!_account_missing(accounts.a_vault), "A_VAULT_MISSING");
        require(!_account_missing(accounts.b_vault), "B_VAULT_MISSING");
        require(_account_missing(accounts.pool), "POOL_EXISTS");

        SystemProgramLib.Instruction memory ix =
            DAMMv1Lib.build_initialize_permissionless_constant_product_pool_with_config2_instruction(
                accounts,
                token_a_amount,
                token_b_amount,
                prog_dynamic_amm
            );
        _invoke_signed(ix, token_factory.users().payer_salt());
        pool_pubkey = accounts.pool;
    }

    function addPool(bytes32 pubkey) external returns (address pool) {
        return _register_pool(pubkey);
    }

    function _account_missing(bytes32 pubkey) internal view returns (bool) {
        (uint64 lamports,,,,,) = ICrossProgramInvocation(cpi_program).account_info(pubkey);
        return lamports == 0;
    }

    function _sameInitializePermissionlessPoolWithConfigAccounts(
        DAMMv1Lib.InitializePermissionlessPoolWithConfigAccounts memory a,
        DAMMv1Lib.InitializePermissionlessPoolWithConfigAccounts memory b
    )
    internal
    pure
    returns (bool)
    {
        return a.pool == b.pool
            && a.config == b.config
            && a.lp_mint == b.lp_mint
            && a.token_a_mint == b.token_a_mint
            && a.token_b_mint == b.token_b_mint
            && a.a_vault == b.a_vault
            && a.b_vault == b.b_vault
            && a.a_token_vault == b.a_token_vault
            && a.b_token_vault == b.b_token_vault
            && a.a_vault_lp_mint == b.a_vault_lp_mint
            && a.b_vault_lp_mint == b.b_vault_lp_mint
            && a.a_vault_lp == b.a_vault_lp
            && a.b_vault_lp == b.b_vault_lp
            && a.payer_token_a == b.payer_token_a
            && a.payer_token_b == b.payer_token_b
            && a.payer_pool_lp == b.payer_pool_lp
            && a.protocol_token_a_fee == b.protocol_token_a_fee
            && a.protocol_token_b_fee == b.protocol_token_b_fee
            && a.payer == b.payer
            && a.rent == b.rent
            && a.vault_program == b.vault_program
            && a.token_program == b.token_program
            && a.associated_token_program == b.associated_token_program
            && a.system_program == b.system_program
            && a.metadata_program == b.metadata_program
            && a.mint_metadata == b.mint_metadata;
    }

    function _register_pool(bytes32 pubkey) internal returns (address pool) {
        DAMMv1Lib.PoolState memory pool_state = DAMMv1Lib.load_pool(pubkey, cpi_program);
        address token_a_address = token_factory.token_by_mint(pool_state.token_a_mint);
        address token_b_address = token_factory.token_by_mint(pool_state.token_b_mint);

        require(token_a_address != address(0), "TokenA not registered in factory");
        require(token_b_address != address(0), "TokenB not registered in factory");

        (address token0, address token1) = orderTokens(token_a_address, token_b_address);
        require(getPool[token0][token1] == address(0), "PAIR_EXISTS");

        bytes memory bytecode = type(DAMMv1Pool).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pool := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }

        DAMMv1Pool(pool).initialize(
            address(token_factory),
            pubkey,
            prog_dynamic_vault,
            prog_dynamic_amm,
            cpi_program
        );

        ERC20DAMMv1Pool erc20_pool = new ERC20DAMMv1Pool(DAMMv1Pool(pool), token_factory);
        getPool[token0][token1] = address(erc20_pool);
        getPool[token1][token0] = address(erc20_pool);
        allPools.push(address(erc20_pool));
        emit PoolAdded(token0, token1, address(erc20_pool), allPools.length);

        return address(erc20_pool);
    }

    function _invoke_signed(SystemProgramLib.Instruction memory ix, bytes32 seed) internal {
        bytes32[] memory seeds = new bytes32[](1);
        seeds[0] = seed;

        (bool success, bytes memory result) = address(cpi_program).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                ix.program_id,
                ix.accounts,
                ix.data,
                seeds
            )
        );

        require(success, string(Convert.revert_msg(result)));
    }
}
