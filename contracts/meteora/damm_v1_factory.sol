// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {DAMMv1Lib, DAMMv1Pool} from "./damm_v1_pool.sol";

contract MeteoraDAMMv1Factory {
    mapping(bytes32 => mapping(bytes32 => address)) public getPool;
    address[] public allPools;

    event PoolAdded(
        bytes32 indexed token0,
        bytes32 indexed token1,
        address pair,
        uint
    );

    bytes32 public constant PROG_DYNAMIC_AMM =
    0xcbe5357484699af28489f7d3f863df8f04c10db8bf8f753ea7f2d79e6e09f4b0; // Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB
    bytes32 public constant PROG_DYNAMIC_VAULT =
    0x1051efe75a2e47e09ee987cf6761dffaad9aca72a74206ded07e0773d5975e4c; // 24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi

    bytes32 public prog_dynamic_vault;
    bytes32 public prog_dynamic_amm;

    constructor(
        bytes32 _prog_dynamic_vault,
        bytes32 _prog_dynamic_amm
    ) {
        prog_dynamic_vault = _prog_dynamic_vault;
        prog_dynamic_amm = _prog_dynamic_amm;
    }

    function allPoolsLength() external view returns (uint) {
        return allPools.length;
    }

    function addPool(
        bytes32 pubkey
    ) external returns (address pool) {
        DAMMv1Lib.PoolState memory pool_state = DAMMv1Lib.load_pool(pubkey);
        (bytes32 token0, bytes32 token1) = pool_state.token_a_mint < pool_state.token_b_mint
            ? (pool_state.token_a_mint, pool_state.token_b_mint)
            : (pool_state.token_b_mint, pool_state.token_a_mint);

        require(getPool[token0][token1] == address(0), "PAIR_EXISTS");
        bytes memory bytecode = type(DAMMv1Pool).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pool := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        DAMMv1Pool(pool).initialize(
            pubkey, prog_dynamic_vault, prog_dynamic_amm
        );
        getPool[token0][token1] = pool;
        getPool[token1][token0] = pool; // populate mapping in the reverse direction
        allPools.push(pool);
        emit PoolAdded(token0, token1, pool, allPools.length);
    }
}