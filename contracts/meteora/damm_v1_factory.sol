// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DAMMv1Lib, DAMMv1Pool, ERC20DAMMv1Pool} from "./damm_v1_pool.sol";
import {ERC20SPLFactory} from "../erc20spl/erc20spl_factory.sol";
import {ERC20Users} from "../erc20spl/erc20spl.sol";
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

    function derivePermissionlessPoolKeyWithFeeTier(
        bytes32 token_a_mint,
        bytes32 token_b_mint,
        uint64 trade_fee_bps
    )
    public
    view
    returns (bytes32)
    {
        return DAMMv1Lib.derive_permissionless_pool_key_with_fee_tier(
            DAMMv1Lib.CurveType.ConstantProduct,
            token_a_mint,
            token_b_mint,
            trade_fee_bps,
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
        ERC20Users.User memory initiator = ERC20Users(token_factory.users()).get_user(user);
        (should_initialize, , accounts_) = DAMMv1Lib.prepare_initialize_vault(
            token_mint,
            initiator.payer,
            prog_dynamic_vault,
            vault_override_network,
            cpi_program
        );
    }

    function initializeVaultIfMissing(bytes32 token_mint) external returns (bytes32 vault, bool initialized_) {
        ERC20Users.User memory initiator = ERC20Users(token_factory.users()).get_user(msg.sender);

        (
            bool should_initialize,
            SystemProgramLib.Instruction memory ix,
            DAMMv1Lib.InitializeVaultAccounts memory accounts_
        ) = DAMMv1Lib.prepare_initialize_vault(
            token_mint,
            initiator.payer,
            prog_dynamic_vault,
            vault_override_network,
            cpi_program
        );

        vault = accounts_.vault;
        if (!should_initialize) {
            return (vault, false);
        }

        _invoke_signed(ix, initiator.seed);
        return (vault, true);
    }

    function previewInitializePermissionlessPoolWithFeeTier(
        bytes32 token_a_mint,
        bytes32 token_b_mint,
        uint64 trade_fee_bps,
        uint64 token_a_amount,
        uint64 token_b_amount,
        address user
    )
    external
    view
    returns (
        bool pool_exists,
        bool a_vault_exists,
        bool b_vault_exists,
        DAMMv1Lib.InitializePermissionlessPoolAccounts memory accounts_
    ) {
        ERC20Users.User memory initiator = ERC20Users(token_factory.users()).get_user(user);
        DAMMv1Lib.InitializePermissionlessPoolConfig memory config =
            DAMMv1Lib.InitializePermissionlessPoolConfig({
                curve_type: DAMMv1Lib.CurveType.ConstantProduct,
                token_a_mint: token_a_mint,
                token_b_mint: token_b_mint,
                trade_fee_bps: trade_fee_bps,
                token_a_amount: token_a_amount,
                token_b_amount: token_b_amount,
                payer: initiator.payer,
                owner: initiator.owner,
                fee_owner: bytes32(0),
                dynamic_vault_program: prog_dynamic_vault,
                dynamic_amm_program: prog_dynamic_amm,
                override_network: vault_override_network
            });
        (pool_exists, a_vault_exists, b_vault_exists, , accounts_) =
            DAMMv1Lib.prepare_initialize_permissionless_pool_with_fee_tier(
                config,
                cpi_program
            );
    }

    function createPermissionlessPoolWithFeeTier(
        bytes32 token_a_mint,
        bytes32 token_b_mint,
        uint64 trade_fee_bps,
        uint64 token_a_amount,
        uint64 token_b_amount
    ) external returns (bytes32 pool_pubkey) {
        ERC20Users.User memory initiator = ERC20Users(token_factory.users()).get_user(msg.sender);
        DAMMv1Lib.InitializePermissionlessPoolConfig memory config =
            DAMMv1Lib.InitializePermissionlessPoolConfig({
                curve_type: DAMMv1Lib.CurveType.ConstantProduct,
                token_a_mint: token_a_mint,
                token_b_mint: token_b_mint,
                trade_fee_bps: trade_fee_bps,
                token_a_amount: token_a_amount,
                token_b_amount: token_b_amount,
                payer: initiator.payer,
                owner: initiator.owner,
                fee_owner: bytes32(0),
                dynamic_vault_program: prog_dynamic_vault,
                dynamic_amm_program: prog_dynamic_amm,
                override_network: vault_override_network
            });

        (
            bool pool_exists,
            bool a_vault_exists,
            bool b_vault_exists,
            SystemProgramLib.Instruction memory ix,
            DAMMv1Lib.InitializePermissionlessPoolAccounts memory accounts_
        ) = DAMMv1Lib.prepare_initialize_permissionless_pool_with_fee_tier(
            config,
            cpi_program
        );

        require(a_vault_exists, "A_VAULT_MISSING");
        require(b_vault_exists, "B_VAULT_MISSING");
        require(!pool_exists, "POOL_EXISTS");

        _invoke_signed(ix, initiator.seed);
        pool_pubkey = accounts_.pool;
    }

    function addPool(bytes32 pubkey) external returns (address pool) {
        return _register_pool(pubkey);
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
