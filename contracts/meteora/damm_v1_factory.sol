// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DAMMv1Lib, DAMMv1Pool} from "./damm_v1_pool.sol";
import {ERC20SPLFactory} from "../erc20spl/erc20spl_factory.sol";

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

    bytes32 public constant PROG_DYNAMIC_AMM =
    0xcbe5357484699af28489f7d3f863df8f04c10db8bf8f753ea7f2d79e6e09f4b0; // Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB
    bytes32 public constant PROG_DYNAMIC_VAULT =
    0x1051efe75a2e47e09ee987cf6761dffaad9aca72a74206ded07e0773d5975e4c; // 24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi

    bytes32 public prog_dynamic_vault;
    bytes32 public prog_dynamic_amm;
    address public cpi_program;

    constructor(
        bytes32 _prog_dynamic_vault,
        bytes32 _prog_dynamic_amm,
        address _cpi_program
    ) {
        prog_dynamic_vault = _prog_dynamic_vault;
        prog_dynamic_amm = _prog_dynamic_amm;
        cpi_program = _cpi_program;
    }

    function allPoolsLength() external view returns (uint) {
        return allPools.length;
    }

    function orderTokens(address tokenA, address tokenB) public view returns (address token0, address token1) {
        (token0, token1) = tokenA < tokenB
            ? (tokenA, tokenB)
            : (tokenB, tokenA);

        return (token0, token1);
    }

    function addPool(
        bytes32 pubkey
    ) external returns (address pool) {
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
            pubkey, prog_dynamic_vault, prog_dynamic_amm, cpi_program
        );
        getPool[token0][token1] = pool;
        getPool[token1][token0] = pool; // populate mapping in the reverse direction
        allPools.push(pool);
        emit PoolAdded(token0, token1, pool, allPools.length);
    }
}
