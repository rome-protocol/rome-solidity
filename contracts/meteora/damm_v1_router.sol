// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MeteoraDAMMv1Factory} from "./damm_v1_factory.sol";
import {DAMMv1Pool, ERC20DAMMv1Pool} from "./damm_v1_pool.sol";
import {SPL_ERC20} from "../erc20spl/erc20spl.sol";
import {Convert} from "../convert.sol";

contract MeteoraDAMMv1Router {
    MeteoraDAMMv1Factory public immutable factory;
    address public cpi_program;

    constructor(MeteoraDAMMv1Factory _factory, address _cpi_program) {
        factory = _factory;
        cpi_program = _cpi_program;
    }

    function swapExactTokensForTokens(
        address token_in,
        address token_out,
        uint256 amount_in,
        uint256 min_amount_out
    ) external {
        address pool = factory.getPool(token_in, token_out);
        require(pool != address(0), "Pool does not exist");

        (bool success, bytes memory result) = pool.delegatecall(
            abi.encodeWithSelector(
                ERC20DAMMv1Pool.swapExactTokensForTokens.selector,
                token_in, amount_in, min_amount_out
            )
        );

        require (success, string(Convert.revert_msg(result)));
    }
}