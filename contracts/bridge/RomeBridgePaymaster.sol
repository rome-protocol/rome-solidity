// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {RomeBridgeEvents} from "./RomeBridgeEvents.sol";

/// @title RomeBridgePaymaster
/// @notice EIP-2771 trusted forwarder that sponsors up to `sponsoredTxCap` Rome EVM
///         transactions per user, restricted to an allowlist of (target, selector) pairs.
/// @dev Sponsorship budget is only consumed when a request actually executes. Batch
///      mode requests that fail signature/deadline validation are skipped without
///      charging the budget. Callers must be aware: once exhausted, a user's budget
///      does not reset automatically — operator can raise the per-user cap via
///      `setSponsoredTxCap` to grant additional sponsorship retroactively.
contract RomeBridgePaymaster is ERC2771Forwarder, Ownable, Pausable, RomeBridgeEvents {
    /// @notice Per-user sponsorship cap. Owner-mutable via `setSponsoredTxCap`.
    ///         Default is 3 (set in the constructor) — chosen for the Phase 1
    ///         inbound-bridge flow which needs at most 2 relayed calls per
    ///         user (approve + settleInbound), with one in reserve.
    uint8 public sponsoredTxCap;

    /// @dev Per-user consumed sponsorship count. Never auto-resets — a user who
    ///      exhausts their budget must either pay gas themselves thereafter or
    ///      get the cap raised by the operator.
    mapping(address => uint8) public sponsoredTxCount;

    mapping(address => mapping(bytes4 => bool)) public allowlist;

    error BudgetExhausted(address user);
    error TargetNotAllowed(address target, bytes4 selector);

    /// @dev Local to this contract (admin surface). Cross-contract observable events
    ///      like PaymasterSponsored live in RomeBridgeEvents for indexer composability.
    event AllowlistUpdated(address indexed target, bytes4 indexed selector, bool allowed);

    /// @notice Emitted when the owner changes the per-user sponsorship cap.
    event SponsoredTxCapChanged(uint8 indexed previousCap, uint8 indexed newCap);

    constructor(address admin)
        ERC2771Forwarder("RomeBridgePaymaster")
        Ownable(admin)
    {
        sponsoredTxCap = 3;
    }

    /// @notice Adds or removes an (target, selector) pair from the sponsorship allowlist.
    /// @dev Admin-only; emits AllowlistUpdated.
    function setAllowlistEntry(address target, bytes4 selector, bool allowed) external onlyOwner {
        allowlist[target][selector] = allowed;
        emit AllowlistUpdated(target, selector, allowed);
    }

    /// @notice Owner-only update of the per-user sponsorship cap.
    /// @dev Lowering the cap doesn't refund existing counters; raising it lets
    ///      already-exhausted users be sponsored again up to the new ceiling.
    function setSponsoredTxCap(uint8 newCap) external onlyOwner {
        uint8 previousCap = sponsoredTxCap;
        sponsoredTxCap = newCap;
        emit SponsoredTxCapChanged(previousCap, newCap);
    }

    /// @notice Pause the relayed-execution path. Inherited Pausable; owner-only.
    /// @dev While paused, both `execute()` and `executeBatch()` revert via the
    ///      `whenNotPaused` modifier on `_execute`. Use for incident response —
    ///      e.g. if a flaw is found in one of the allowlisted targets, the
    ///      operator can pause without iterating the allowlist to remove entries.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume the relayed-execution path after a pause.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @dev Override of ERC2771Forwarder._execute that enforces the (target, selector)
    ///      allowlist, the pause state, and charges the per-user sponsorship budget.
    ///      Budget is charged AFTER super._execute so that batch-mode requests with
    ///      invalid signatures (which OZ skips silently, returning success=false)
    ///      do not consume the victim's budget. In the execute() path
    ///      (requireValidRequest=true), bad sigs revert inside super and never reach
    ///      the budget logic. In the executeBatch() path (requireValidRequest=false),
    ///      only requests where success=true were actually dispatched and count
    ///      against the budget.
    function _execute(
        ForwardRequestData calldata request,
        bool requireValidRequest
    ) internal override whenNotPaused returns (bool success) {
        // Allowlist check applies to all code paths.
        bytes4 selector = _extractSelector(request.data);
        if (!allowlist[request.to][selector]) {
            revert TargetNotAllowed(request.to, selector);
        }

        // Delegate validation and the actual call to super.
        // requireValidRequest=true: bad sigs revert here, so we never proceed.
        // requireValidRequest=false: bad sigs cause super to return false without
        // calling the target — the nonce is not consumed and success stays false.
        success = super._execute(request, requireValidRequest);

        // Charge the budget only when the request was actually dispatched.
        // - requireValidRequest=true + we got past super: sig was valid, call ran.
        // - requireValidRequest=false + success=true: sig was valid, call ran.
        // - requireValidRequest=false + success=false: request was skipped — do not charge.
        if (requireValidRequest || success) {
            address user = request.from;
            uint8 current = sponsoredTxCount[user];
            uint8 cap = sponsoredTxCap;
            if (current >= cap) {
                revert BudgetExhausted(user);
            }
            unchecked { sponsoredTxCount[user] = current + 1; }
            emit PaymasterSponsored(user, cap - current - 1, request.to);
        }
    }

    function _extractSelector(bytes calldata data) private pure returns (bytes4) {
        if (data.length < 4) return bytes4(0);
        return bytes4(data[0:4]);
    }
}
