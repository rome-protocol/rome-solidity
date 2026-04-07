// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MeteoraDAMMv1Factory} from "./damm_v1_factory.sol";

contract MeteoraDAMMv1Router {
    MeteoraDAMMv1Factory public immutable factory;
    address public cpi_program;

    constructor(MeteoraDAMMv1Factory _factory, address _cpi_program) {
        factory = _factory;
        cpi_program = _cpi_program;
    }

    function swap(
        address token_in,
        address token_out,
        uint256 amount_in,
        uint256 min_amount_out,
        bytes32 recipient
    ) external {
        address pool = factory.getPool(token_in, token_out);
        require(pool != address(0), "Pool does not exist");

        (bool success, bytes memory result) = pool.delegatecall(
            abi.encodeWithSignature(
                "swap(address,address,uint256,uint256,bytes32,address)",
                token_in,
                token_out,
                amount_in,
                min_amount_out,
                recipient,
                msg.sender
            )
        );
        require(success, string(result));
    }

    function swapExactTokensForTokens(
        address token_in,
        address token_out,
        uint256 amount_in,
        uint256 min_amount_out
    ) external {
        address pool = factory.getPool(token_in, token_out);
        require(pool != address(0), "Pool does not exist");



        swap(token_in, token_out, amount_in, min_amount_out, recipient);
    }
}