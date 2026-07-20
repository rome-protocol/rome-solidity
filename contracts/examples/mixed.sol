// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";

// mixed_example — legal coexistence of cached and non-cached
// precompiles within a single Solidity call frame.
//
// The dispatch rule, enforced by `verify_call` in the Rome EVM program
// program/src/state/handler_non_evm.rs:
//   - A non-cached MUTATING call (Invoke/Composed) sets `found_cpi`.
//   - A cached MUTATING call (Invoke/Composed) sets `found_cpi_cached`.
//   - Either flag, once set, rejects subsequent MUTATING calls on the
//     other path with NonEvmCallError.
//   - These flags live on JournaledState, NOT on the per-frame journal.
//     They are tx-scoped: an EVM revert clears journal diffs but does
//     NOT clear these flags. Once a tx has dispatched a non-cached
//     mutation, no cached mutation can run in that tx, period.
//
// What stays freely mixable:
//   - EthCall (pure reads of this rollup's own state) from either path.
//   - CrossStateEthCall from the non-cached path (reading Solana
//     accounts via CpiProgram, etc.) before any mutation runs.
//   - Reads of both paths in any order.
//
// Typical real-world pattern: derive Solana addresses via the
// non-cached HelperProgram + SystemProgram (pure reads, no flag), then
// dispatch the actual revertable mutation via the cached precompile.

contract mixed_example {

    // ─── Legal mix: non-cached reads + cached mutation ───────────────
    // Derive the chain mint and the caller's gas-mint ATA via
    // non-cached EthCall views (neither flag set), then send chain-gas
    // SPL via SplCached so the side effect is revertable.

    function send_chain_gas_spl(address to) external {
        bytes32 mint = SystemProgram.mint_id();
        bytes32 sender_ata = HelperProgram.ata(msg.sender, mint);
        require(sender_ata != bytes32(0), "ata lookup failed");

        (bool ok, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "transfer(address,uint256,bytes32)", to, 1 ether, mint
            )
        );
        require(ok, "cached transfer failed");
    }

    // ─── Legal mix: cross-program read + cached mutation ─────────────
    // Read an arbitrary Solana account through the non-cached CPI
    // shortcut (CrossStateEthCall, no found_cpi set), use the data to
    // decide whether to dispatch the cached withdraw.

    function conditional_withdraw(bytes32 owner, bytes32 reserve_account)
        external payable
    {
        uint64 reserve_lamports = CpiProgram.account_lamports(reserve_account);
        require(reserve_lamports > 0, "reserve empty");

        (bool ok, ) = address(WithdrawCached).delegatecall(
            abi.encodeWithSignature("withdrawal(bytes32)", owner)
        );
        require(ok, "withdrawal failed");
    }

    // ─── Legal mix: read-only summary of both paths ──────────────────
    // Both pdas come from non-cached EthCall; the chain mint comes from
    // the same. Pure read, no flags set, both paths quiet.

    function describe(address user)
        external view
        returns (bytes32 pda_, bytes32 ata_, bytes32 mint_)
    {
        mint_ = SystemProgram.mint_id();
        pda_ = HelperProgram.pda(user);
        ata_ = HelperProgram.ata(user, mint_);
    }

    // ─── Anti-pattern (documentation only — do NOT call) ─────────────
    // The two functions below would both fail on-chain after the first
    // mutation, because verify_call rejects the second. Kept here so
    // future readers see the shape of the rule. Not wrapped in
    // try/catch: the flag set by the first call PERSISTS past any EVM
    // revert, so a try/catch demo would leave the tx in a permanently
    // restricted state (no further mutations on the other path can
    // succeed for the entire tx).

    function illegal_noncached_then_cached(address recipient) external {
        // Sets found_cpi.
        (bool ok1, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "transfer_spl(address,uint64)", recipient, 1000000
            )
        );
        require(ok1, "non-cached step failed");
        // Rejected with NonEvmCallError(
        //   "attempt to use cpi-cached program with cpi-program"
        // ) — the cached precompile path is locked out for the rest of
        // this tx after found_cpi flipped above.
        (bool ok2, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "transfer(address,uint256)", recipient, 1 ether
            )
        );
        require(ok2, "cached step rejected (expected)");
    }

    function illegal_cached_then_noncached(address recipient) external {
        // Sets found_cpi_cached.
        (bool ok1, ) = address(SplCached).delegatecall(
            abi.encodeWithSignature(
                "transfer(address,uint256)", recipient, 1 ether
            )
        );
        require(ok1, "cached step failed");
        // Rejected with the same NonEvmCallError — symmetric.
        (bool ok2, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "transfer_spl(address,uint64)", recipient, 1000000
            )
        );
        require(ok2, "non-cached step rejected (expected)");
    }
}
