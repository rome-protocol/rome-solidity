// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";

// bench_cached — paired cached / cpi demonstrators for every cached-track
// selector shipped in a Rome EVM program upgrade + #383 that has a clean CPI-path
// CPI equivalent on `HelperProgram` / `Withdraw`. For each pair, calling
// the two methods in separate txs lets a bench script measure
// apple-to-apple Solana CU + heap cost.
//
// Pure-read selectors (`SplCached.account(...)`) are intentionally omitted
// — they dispatch as `CrossStateEthCall`, no CPI overhead vs the CPI
// equivalents (`HelperProgram.user_balance`).
//
// Cached-only selectors with no direct CPI counterpart are exposed
// without a pair (the salt-based variants on `SystemCached`).
//
// Track discipline (per CLAUDE.md): this contract calls BOTH cached and
// CPI precompiles, but only from separate top-level txs — the per-tx
// `verify_call` gate fires only within a single tx, not across txs. Tests
// must NOT batch a cached call and a CPI call in the same tx.
contract bench_cached {

    // ── SystemCached (0xff..04) vs CPI HelperProgram ────────────

    function cached_create_pda() external {
        (bool ok, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("create_pda()")
        );
        require(ok, "revert");
    }
    function cpi_create_pda(address user) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("create_pda(address)", user)
        );
        require(ok, "revert");
    }

    function cached_create_pda_with_lamports(uint64 lamports) external {
        (bool ok, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("create_pda(uint64)", lamports)
        );
        require(ok, "revert");
    }
    function cpi_create_pda_with_lamports(address user, uint64 lamports) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("create_pda(address,uint64)", user, lamports)
        );
        require(ok, "revert");
    }

    // Cached-only — no salt-derived create_pda on HelperProgram.
    function cached_create_pda_with_salt(uint64 lamports, bytes32 salt) external {
        (bool ok, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("create_pda(uint64,bytes32)", lamports, salt)
        );
        require(ok, "revert");
    }
    function cached_create_pda_owned(bytes32 owner, uint64 len, bytes32 salt) external {
        (bool ok, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature(
                "create_pda(bytes32,uint64,bytes32)", owner, len, salt
            )
        );
        require(ok, "revert");
    }
    function cached_allocate(uint64 len, bytes32 salt) external {
        (bool ok, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("allocate(uint64,bytes32)", len, salt)
        );
        require(ok, "revert");
    }
    function cached_assign(bytes32 owner, bytes32 salt) external {
        (bool ok, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("assign(bytes32,bytes32)", owner, salt)
        );
        require(ok, "revert");
    }
    function cached_system_transfer(address to, uint64 lamports) external {
        (bool ok, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("transfer(address,uint64)", to, lamports)
        );
        require(ok, "revert");
    }
    function cpi_system_transfer(address to, uint64 lamports) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("transfer_lamports(address,uint64)", to, lamports)
        );
        require(ok, "revert");
    }
    function cached_system_transfer_b32(bytes32 to, uint64 lamports) external {
        (bool ok, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("transfer(bytes32,uint64)", to, lamports)
        );
        require(ok, "revert");
    }
    function cached_system_transfer_b32_salt(bytes32 to, uint64 lamports, bytes32 salt) external {
        (bool ok, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature(
                "transfer(bytes32,uint64,bytes32)", to, lamports, salt
            )
        );
        require(ok, "revert");
    }

    // ── SplCached (0xff..05) vs CPI HelperProgram ───────────────

    function cached_spl_transfer(address to, uint256 amount) external {
        (bool ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );
        require(ok, "revert");
    }
    function cpi_spl_transfer(address to, uint64 amount) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("transfer_spl(address,uint64)", to, amount)
        );
        require(ok, "revert");
    }

    function cached_spl_transfer_to_pda(bytes32 to_pda, uint256 amount) external {
        (bool ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature("transfer(bytes32,uint256)", to_pda, amount)
        );
        require(ok, "revert");
    }
    function cpi_spl_transfer_to_pda(bytes32 to_pda, uint64 amount) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("transfer_spl(bytes32,uint64)", to_pda, amount)
        );
        require(ok, "revert");
    }

    function cached_spl_transfer_with_mint(address to, uint256 amount, bytes32 mint) external {
        (bool ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "transfer(address,uint256,bytes32)", to, amount, mint
            )
        );
        require(ok, "revert");
    }
    function cpi_spl_transfer_with_mint(address to, uint64 amount, bytes32 mint) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "transfer_spl(address,uint64,bytes32)", to, amount, mint
            )
        );
        require(ok, "revert");
    }

    function cached_spl_transfer_to_pda_with_mint(bytes32 to_pda, uint256 amount, bytes32 mint) external {
        (bool ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "transfer(bytes32,uint256,bytes32)", to_pda, amount, mint
            )
        );
        require(ok, "revert");
    }
    function cpi_spl_transfer_to_pda_with_mint(bytes32 to_pda, uint64 amount, bytes32 mint) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "transfer_spl(bytes32,uint64,bytes32)", to_pda, amount, mint
            )
        );
        require(ok, "revert");
    }

    // SplCached.init has no direct cpi equivalent (initializes an SPL
    // TokenAccount in-place via TokenInstruction::InitializeAccount3).
    function cached_spl_init(bytes32 ata, bytes32 mint, bytes32 owner) external {
        (bool ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "init(bytes32,bytes32,bytes32)", ata, mint, owner
            )
        );
        require(ok, "revert");
    }

    // ── SplCached PR #383 selectors vs CPI HelperProgram ───────

    function cached_transferFrom(address from, address to, uint256 amount, bytes32 mint) external {
        (bool ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "transferFrom(address,address,uint256,bytes32)",
                from, to, amount, mint
            )
        );
        require(ok, "revert");
    }
    function cpi_transferFrom(address from, address to, uint64 amount, bytes32 mint) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "transfer_spl(address,address,uint64,bytes32)",
                from, to, amount, mint
            )
        );
        require(ok, "revert");
    }

    function cached_approve(address spender, uint256 amount, bytes32 mint) external {
        (bool ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "approve(address,uint256,bytes32)", spender, amount, mint
            )
        );
        require(ok, "revert");
    }
    function cpi_approve(address spender, uint64 amount, bytes32 mint) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "approve_spl(address,uint64,bytes32)", spender, amount, mint
            )
        );
        require(ok, "revert");
    }

    function cached_mint(address to, uint256 amount, bytes32 mint) external {
        (bool ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "mint(address,uint256,bytes32)", to, amount, mint
            )
        );
        require(ok, "revert");
    }
    function cpi_mint(address to, uint64 amount, bytes32 mint) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "mint_spl(address,uint64,bytes32)", to, amount, mint
            )
        );
        require(ok, "revert");
    }

    // ── ASplCached (0xff..06) vs CPI HelperProgram ──────────────

    // create_ata() (self, default mint) — no cpi equivalent that takes
    // zero args; pair with HelperProgram.create_ata(address) with the
    // caller's own EVM address.
    function cached_create_ata_self() external {
        (bool ok, ) = address(AssociatedSplCached).delegatecall(
            abi.encodeWithSignature("create_ata()")
        );
        require(ok, "revert");
    }
    function cpi_create_ata_self(address user) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("create_ata(address)", user)
        );
        require(ok, "revert");
    }

    function cached_create_ata_self_with_mint(bytes32 mint) external {
        (bool ok, ) = address(AssociatedSplCached).delegatecall(
            abi.encodeWithSignature("create_ata(bytes32)", mint)
        );
        require(ok, "revert");
    }
    // (paired with cpi_create_ata_for_user_with_mint below)

    function cached_create_ata_for_user(address user) external {
        (bool ok, ) = address(AssociatedSplCached).delegatecall(
            abi.encodeWithSignature("create_ata(address)", user)
        );
        require(ok, "revert");
    }
    // Same cpi selector as cached_create_ata_self (HelperProgram.create_ata
    // is addr-keyed only).

    function cached_create_ata_for_user_with_mint(address user, bytes32 mint) external {
        (bool ok, ) = address(AssociatedSplCached).delegatecall(
            abi.encodeWithSignature("create_ata(address,bytes32)", user, mint)
        );
        require(ok, "revert");
    }
    function cpi_create_ata_for_user_with_mint(address user, bytes32 mint) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("create_ata(address,bytes32)", user, mint)
        );
        require(ok, "revert");
    }

    // ── WithdrawCached (0xff..0b) vs CPI Withdraw (0x42..16) ────

    function cached_withdrawal(bytes32 owner) external payable {
        (bool ok, ) = address(WithdrawCached).call{value: msg.value}(
            abi.encodeWithSignature("withdrawal(bytes32)", owner)
        );
        require(ok, "revert");
    }
    function cpi_withdrawal(bytes32 owner) external payable {
        (bool ok, ) = address(Withdraw).call{value: msg.value}(
            abi.encodeWithSignature("withdrawal(bytes32)", owner)
        );
        require(ok, "revert");
    }

    function cached_withdraw_to_pda(uint256 wei_) external {
        (bool ok, ) = address(WithdrawCached).delegatecall(
            abi.encodeWithSignature("withdraw_to_pda(uint256)", wei_)
        );
        require(ok, "revert");
    }
    function cpi_withdraw_to_pda(uint256 wei_) external {
        (bool ok, ) = address(Withdraw).delegatecall(
            abi.encodeWithSignature("withdraw_to_pda(uint256)", wei_)
        );
        require(ok, "revert");
    }

    function cached_withdraw_to_ata(uint256 wei_) external {
        (bool ok, ) = address(WithdrawCached).delegatecall(
            abi.encodeWithSignature("withdraw_to_ata(uint256)", wei_)
        );
        require(ok, "revert");
    }
    function cpi_withdraw_to_ata(uint256 wei_) external {
        (bool ok, ) = address(Withdraw).delegatecall(
            abi.encodeWithSignature("withdraw_to_ata(uint256)", wei_)
        );
        require(ok, "revert");
    }

    // ── WithdrawCached PR #383 selector vs CPI HelperProgram ────
    // Renamed in a Rome EVM program upgrade (merged 2026-05-23) from
    // `withdraw_from_ata(uint256)` `0x214ee485` to `deposit(uint256)`
    // `0xb6b55f25`. Bench method name kept as `cached_deposit` to track.

    function cached_deposit(uint256 wei_) external {
        (bool ok, ) = address(WithdrawCached).delegatecall(
            abi.encodeWithSignature("deposit(uint256)", wei_)
        );
        require(ok, "revert");
    }
    function cpi_deposit_from_ata(uint256 wei_) external {
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature("deposit_from_ata(uint256)", wei_)
        );
        require(ok, "revert");
    }
}
