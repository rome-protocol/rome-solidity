// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IUniswapV2PairMinimal {
    function mint(address to) external returns (uint256 liquidity);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @title RomeswapDirect — single-tx wrappers around Romeswap pair ops.
/// @notice Composes the 3-tx Rome-required addLiquidity / 2-tx swap / 2-tx
///         removeLiquidity flows into ONE EVM tx (one Solana DoTx). Each
///         function does the token transfers + the pair op inline. Caller
///         must pre-approve this contract on the underlying tokens.
contract RomeswapDirect {
    /// @notice 1-tx addLiquidity. Pulls amtA of tokenA + amtB of tokenB from
    ///         caller (transferFrom — caller must have pre-approved this
    ///         contract on both tokens) directly into the pair, then mints
    ///         LP tokens to `to`. Caller pre-computes amounts off-chain
    ///         (no slippage / optimal-amounts logic).
    function addLiq(
        address tokenA,
        address tokenB,
        address pair,
        uint256 amtA,
        uint256 amtB,
        address to
    ) external returns (uint256 liquidity) {
        IERC20Minimal(tokenA).transferFrom(msg.sender, pair, amtA);
        IERC20Minimal(tokenB).transferFrom(msg.sender, pair, amtB);
        liquidity = IUniswapV2PairMinimal(pair).mint(to);
    }

    /// @notice 1-tx swap. Pulls amtIn of tokenIn from caller into the pair,
    ///         then calls pair.swap with the pre-computed output amounts.
    ///         Caller pre-computes (amount0Out, amount1Out) off-chain.
    function swap(
        address tokenIn,
        address pair,
        uint256 amtIn,
        uint256 amount0Out,
        uint256 amount1Out,
        address to
    ) external {
        IERC20Minimal(tokenIn).transferFrom(msg.sender, pair, amtIn);
        IUniswapV2PairMinimal(pair).swap(amount0Out, amount1Out, to, "");
    }

    /// @notice 1-tx removeLiquidity. Pulls lpAmt of LP tokens (pair-as-ERC20)
    ///         from caller into the pair, then burns them to `to`.
    function removeLiq(
        address pair,
        uint256 lpAmt,
        address to
    ) external returns (uint256 amount0, uint256 amount1) {
        IERC20Minimal(pair).transferFrom(msg.sender, pair, lpAmt);
        (amount0, amount1) = IUniswapV2PairMinimal(pair).burn(to);
    }
}
