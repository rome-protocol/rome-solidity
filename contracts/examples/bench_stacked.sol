// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";

// bench_stacked — stacked-op flows comparing cached vs CPI tracks when
// MULTIPLE SPL operations happen in a single EVM tx. This is where the
// cached track's defining benefit (revert atomicity across the whole stack)
// has the most leverage AND where the cost trade-off can flip — large
// stacks may force one track into iterative-VM while the other stays
// atomic, swinging the cost comparison.
//
// Two test shapes:
//
//   1. n-stacked SPL transfer — N identical SPL transfer_checked calls in
//      one EVM tx. Sweep N to find:
//        - the linear cost regime (atomic on both)
//        - the crossover where one track spills to iterative
//        - the CU ceiling where both go iterative
//
//   2. add-liquidity-shape — 2 approves + 2 transferFroms + 1 transfer in
//      one EVM tx. Mirrors a router's actual call pattern (approve A,
//      approve B, pull A, pull B, push LP). Tests heterogeneous mix
//      rather than N copies of one op.
//
// Track discipline: each external method calls ONE track. Caller picks
// cached_* vs cpi_*; never mixes within a tx.

contract bench_stacked {

    // ── N-stacked SPL transfer ──────────────────────────────────────

    function cached_n_self_transfers(
        uint8 n, address to, uint256 amount, bytes32 mint
    ) external {
        for (uint8 i = 0; i < n; i++) {
            (bool ok, ) = address(SplCached).delegatecall(
                abi.encodeWithSignature(
                    "transfer(address,uint256,bytes32)", to, amount, mint
                )
            );
            require(ok, "cached step failed");
        }
    }

    function cpi_n_self_transfers(
        uint8 n, address to, uint64 amount, bytes32 mint
    ) external {
        for (uint8 i = 0; i < n; i++) {
            (bool ok, ) = address(HelperProgram).delegatecall(
                abi.encodeWithSignature(
                    "transfer_spl(address,uint64,bytes32)", to, amount, mint
                )
            );
            require(ok, "cpi step failed");
        }
    }

    // ── add-liquidity-shape ──────────────────────────────────────────
    // approve(routerSpender, amt, mintA) — caller authorizes router to pull A
    // approve(routerSpender, amt, mintB) — caller authorizes router to pull B
    // transferFrom(caller, lp, amt, mintA) — router pulls A
    // transferFrom(caller, lp, amt, mintB) — router pulls B
    // transfer(caller, lpShares, mintLp) — router mints LP shares back to caller
    //
    // This shape is what Romeswap router does to add liquidity. Five SPL
    // operations in one EVM tx, in heterogeneous order. The cached track's
    // overlay carries staged ixs through; the CPI track invoke_signeds
    // each one inline.

    function cached_add_liquidity_shape(
        address routerSpender,
        address lp,
        uint256 amt,
        bytes32 mintA, bytes32 mintB, bytes32 mintLp
    ) external {
        (bool ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature("approve(address,uint256,bytes32)", routerSpender, amt, mintA)
        ); require(ok, "step1");
        (ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature("approve(address,uint256,bytes32)", routerSpender, amt, mintB)
        ); require(ok, "step2");
        (ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256,bytes32)",
                msg.sender, lp, amt, mintA
            )
        ); require(ok, "step3");
        (ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256,bytes32)",
                msg.sender, lp, amt, mintB
            )
        ); require(ok, "step4");
        (ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "transfer(address,uint256,bytes32)", msg.sender, amt, mintLp
            )
        ); require(ok, "step5");
    }

    function cpi_add_liquidity_shape(
        address routerSpender,
        address lp,
        uint64 amt,
        bytes32 mintA, bytes32 mintB, bytes32 mintLp
    ) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("approve_spl(address,uint64,bytes32)", routerSpender, amt, mintA)
        ); require(ok, "step1");
        (ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("approve_spl(address,uint64,bytes32)", routerSpender, amt, mintB)
        ); require(ok, "step2");
        (ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "transfer_spl(address,address,uint64,bytes32)",
                msg.sender, lp, amt, mintA
            )
        ); require(ok, "step3");
        (ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "transfer_spl(address,address,uint64,bytes32)",
                msg.sender, lp, amt, mintB
            )
        ); require(ok, "step4");
        (ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "transfer_spl(address,uint64,bytes32)", msg.sender, amt, mintLp
            )
        ); require(ok, "step5");
    }
}
