// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";

// cached_example — worked examples for each cached precompile surface.
//
// Cached precompiles dispatch the same Solana side effects as their
// legacy counterparts (System, SPL Token, Associated Token, Withdraw)
// but route through the rome-evm-private journal. The side effects are
// buffered in the journal and applied at commit; on revert (either
// `require` failure or any EVM revert in the call frame) the queued
// instructions are discarded. The non-cached precompiles invoke
// `invoke_signed` immediately and can leave Solana state ahead of EVM
// state if the EVM frame reverts after the CPI.
//
// Source of truth: rome-evm-private/program/src/non_evm_cached/.

contract cached_example {
    uint value = 0;


    // ─── WithdrawCached (0xff..0b) ───────────────────────────────────

    function withdrawal(bytes32 owner) external payable {
        require(msg.value > 0, "send 1 ether");

        (bool success, ) = address(WithdrawCached).call{value: msg.value}(
            abi.encodeWithSignature("withdrawal(bytes32)", owner, 1 ether)
        );
        require(success, "revert");
    }

    function withdraw_to_pda() external {
        (bool success, ) = address(WithdrawCached).delegatecall(
            abi.encodeWithSignature("withdraw_to_pda(uint256)", 1 ether)
        );
        require(success, "revert");
    }

    function withdraw_to_ata() external {
        (bool success, ) = address(WithdrawCached).delegatecall(
            abi.encodeWithSignature("withdraw_to_ata(uint256)", 1 ether)
        );
        require(success, "revert");
    }

    // ─── SystemCached (0xff..04) ─────────────────────────────────────

    function create_pda() external {
        do_iterative();

        (bool success, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("create_pda()")
        );
        require(success, "revert");
    }

    function create_pda_with_lamports() external {
        (bool success, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("create_pda(uint64)", 1000000000)
        );
        require(success, "revert");
    }

    function create_pda_with_salt(bytes32 salt) external {
        (bool success, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("create_pda(uint64,bytes32)", 1000000000, salt)
        );
        require(success, "revert");
    }

    function create_pda_owned(bytes32 owner, bytes32 salt) external {
        (bool success, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature(
                "create_pda(bytes32,uint64,bytes32)",
                owner, 165, salt
            )
        );
        require(success, "revert");
    }

    function allocate(bytes32 salt) external {
        (bool success, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("allocate(uint64,bytes32)", 165, salt)
        );
        require(success, "revert");
    }

    function assign(bytes32 owner, bytes32 salt) external {
        (bool success, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("assign(bytes32,bytes32)", owner, salt)
        );
        require(success, "revert");
    }

    function system_transfer(address to) external {
        (bool success, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("transfer(address,uint64)", to, 1000000)
        );
        require(success, "revert");
    }

    function system_transfer_b32(bytes32 to) external {
        (bool success, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature("transfer(bytes32,uint64)", to, 1000000)
        );
        require(success, "revert");
    }

    function system_transfer_b32_salt(bytes32 to, bytes32 salt) external {
        (bool success, ) = address(SystemCached).delegatecall(
            abi.encodeWithSignature(
                "transfer(bytes32,uint64,bytes32)", to, 1000000, salt
            )
        );
        require(success, "revert");
    }

    // ─── SplCached (0xff..05) ────────────────────────────────────────

    // Same selector as IERC20.transfer — a contract typed as
    // `IERC20(spl_cached_address)` will dispatch a real SPL
    // `transfer_checked` CPI here, signed by the caller's external_auth
    // PDA. Mint defaults to the chain's gas mint.
    function spl_transfer(address to) external {
        (bool success, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature("transfer(address,uint256)", to, 1000000)
        );
        require(success, "revert");
    }

    function spl_transfer_to_pda(bytes32 to_pda) external {
        do_iterative();
        (bool success, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature("transfer(bytes32,uint256)", to_pda, 1 ether)
        );
        require(success, "revert");
    }

    function spl_transfer_with_mint(address to, bytes32 mint) external {
        (bool success, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "transfer(address,uint256,bytes32)", to, 1 ether, mint
            )
        );
        require(success, "revert");
    }

    function spl_transfer_to_pda_with_mint(bytes32 to_pda, bytes32 mint) external {
        (bool success, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "transfer(bytes32,uint256,bytes32)", to_pda, 1 ether, mint
            )
        );
        require(success, "revert");
    }

    function spl_init(bytes32 ata, bytes32 mint, bytes32 owner) external {
        (bool success, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "init(bytes32,bytes32,bytes32)", ata, mint, owner
            )
        );
        require(success, "revert");
    }

    // Read the SPL token-account state for `user`'s gas-mint ATA via
    // the address-overload — the precompile derives
    // ATA(external_auth(user), chain_mint) internally.
    function spl_account(address user) external view returns (ISplCached.Account memory) {
        return SplCached.account(user);
    }

    // Read the SPL token-account state for an arbitrary ATA via the
    // bytes32-overload. The example derives the ATA manually through
    // the non-cached HelperProgram (pure read, no CPI flag engaged) —
    // equivalent to spl_account() above for the gas-mint case, but
    // allows passing any mint or pre-derived ATA.
    function spl_account_b32(address user, bytes32 mint)
        external view
        returns (ISplCached.Account memory)
    {
        bytes32 ata = HelperProgram.ata(user, mint);
        return SplCached.account(ata);
    }

    // ─── AssociatedSplCached (0xff..06) ──────────────────────────────

    function create_ata_self() external {
        do_iterative();
        (bool success, ) = address(AssociatedSplCached).delegatecall(
            abi.encodeWithSignature("create_ata()")
        );
        require(success, "revert");
    }

    function create_ata_self_with_mint(bytes32 mint) external {
        (bool success, ) = address(AssociatedSplCached).delegatecall(
            abi.encodeWithSignature("create_ata(bytes32)", mint)
        );
        require(success, "revert");
    }

    function create_ata_for_user(address user) external {
        (bool success, ) = address(AssociatedSplCached).delegatecall(
            abi.encodeWithSignature("create_ata(address)", user)
        );
        require(success, "revert");
    }

    function create_ata_for_user_with_mint(address user, bytes32 mint) external {
        (bool success, ) = address(AssociatedSplCached).delegatecall(
            abi.encodeWithSignature("create_ata(address,bytes32)", user, mint)
        );
        require(success, "revert");
    }

    // ─── Revert demo ─────────────────────────────────────────────────
    // Demonstrates the cached/non-cached distinction. With cached
    // precompiles, the SPL transfer below is queued in the journal and
    // discarded when the outer call reverts — the recipient's ATA
    // balance does NOT change. The non-cached `Withdraw` (legacy
    // `0x42..16`) would have already invoked the underlying CPI by the
    // time the revert fires, leaving Solana state ahead of EVM state.

    function transfer_then_revert(address to, uint256 amount) external {
        (bool success, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );
        require(success, "spl transfer dispatch failed");
        revert("intentional revert - transfer should be unwound");
    }

    function transfer_in_try_catch(address to, uint256 amount)
        external returns (bool transferred)
    {
        try this.spl_transfer_external(to, amount) {
            transferred = true;
        } catch {
            transferred = false;
        }
    }

    function spl_transfer_external(address to, uint256 amount) external {
        require(msg.sender == address(this), "self-only");
        (bool success, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature("transfer(address,uint256)", to, amount)
        );
        require(success, "revert");
    }

    function do_iterative() internal {
        uint i = 0;

        while (i < 200) {
            value = value + 1;
            i = i + 1;
        }
    }
}
