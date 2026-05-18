// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MeteoraDAMMv1Factory} from "./damm_v1_factory.sol";
import {DAMMv1Lib, DAMMv1Pool, ERC20DAMMv1Pool} from "./damm_v1_pool.sol";
import {SPL_ERC20} from "../erc20spl/erc20spl.sol";
import {Convert} from "../convert.sol";
import {ICrossProgramInvocation} from "../interface.sol";
import {EnsureAta} from "../cpi/EnsureAta.sol";

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

        // Pre-flight: idempotently ensure user's ATAs exist for both sides.
        // Meteora's swap declares `Account<'info, TokenAccount>` constraints
        // on user_source_token / user_destination_token; Anchor rejects with
        // Custom(3012) AccountNotInitialized before the handler runs if
        // either is missing. Composing the create-idempotent calls in the
        // same EVM tx keeps the swap atomic at the user-visible layer.
        // CU: ~50K per side when ATA exists (idempotent no-op CPI), ~110K
        // when creating. Two sides = 100-220K total; well under the 1.4M
        // atomic envelope alongside the swap (~700-900K typical).
        EnsureAta.ensure(msg.sender, SPL_ERC20(token_in).mint_id());
        EnsureAta.ensure(msg.sender, SPL_ERC20(token_out).mint_id());

        (bool success, bytes memory result) = pool.delegatecall(
            abi.encodeWithSelector(
                ERC20DAMMv1Pool.swapExactTokensForTokens.selector,
                token_in, amount_in, min_amount_out
            )
        );

        require (success, string(Convert.revert_msg(result)));
    }

    function addLiquidity(
        address token_a,
        address token_b,
        uint256 pool_token_amount,
        uint256 max_token_a_amount,
        uint256 max_token_b_amount,
        DAMMv1Lib.AddLiquidityUserAccountsInput memory user_accounts
    ) external {
        address pool = factory.getPool(token_a, token_b);
        require(pool != address(0), "Pool does not exist");

        (bool success, bytes memory result) = pool.delegatecall(
            abi.encodeWithSelector(
                ERC20DAMMv1Pool.addLiquidity.selector,
                pool_token_amount,
                max_token_a_amount,
                max_token_b_amount,
                user_accounts
            )
        );

        require(success, string(Convert.revert_msg(result)));
    }

    function prepareAddLiquidity(
        address token_a,
        address token_b,
        address user_evm,
        uint256 max_token_a_amount,
        uint256 max_token_b_amount,
        uint256 slippage_rate
    )
    external
    view
    returns (
        uint64 pool_token_amount,
        DAMMv1Lib.BalanceLiquidityAccountsInput memory liquidity_accounts
    )
    {
        address pool = factory.getPool(token_a, token_b);
        require(pool != address(0), "Pool does not exist");

        return ERC20DAMMv1Pool(pool).prepareAddLiquidity(
            user_evm,
            max_token_a_amount,
            max_token_b_amount,
            slippage_rate
        );
    }

    function ensurePoolLpTokenAccount(
        address token_a,
        address token_b
    ) external {
        address pool = factory.getPool(token_a, token_b);
        require(pool != address(0), "Pool does not exist");

        (bool success, bytes memory result) = pool.delegatecall(
            abi.encodeWithSelector(
                ERC20DAMMv1Pool.ensurePoolLpTokenAccount.selector
            )
        );

        require(success, string(Convert.revert_msg(result)));
    }

    function removeLiquidity(
        address token_a,
        address token_b,
        uint256 pool_token_amount,
        uint256 minimum_a_token_out,
        uint256 minimum_b_token_out
    ) external {
        address pool = factory.getPool(token_a, token_b);
        require(pool != address(0), "Pool does not exist");

        (bool success, bytes memory result) = pool.delegatecall(
            abi.encodeWithSelector(
                ERC20DAMMv1Pool.removeLiquidity.selector,
                pool_token_amount,
                minimum_a_token_out,
                minimum_b_token_out
            )
        );

        require(success, string(Convert.revert_msg(result)));
    }
}
