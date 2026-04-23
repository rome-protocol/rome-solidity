// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CpiError} from "../CpiError.sol";

/// @title CpiAdapterBase — abstract base for every Cardo user-facing adapter.
/// @notice Rolls Ownable + Pausable + ReentrancyGuard + backend pointer +
///         ERC20 rescue + u64 overflow check into one base.
/// @dev
///   Per cardo-foundation.md §3.1. Adapters inherit and drop the 50 LOC of
///   scaffolding each one re-implemented today:
///
///     contract MeteoraCpiAdapter is CpiAdapterBase { … }
///
///   `setBackend` + `BackendUpdated` event lets an adapter point at a
///   rotateable backend contract (Kamino + Drift pattern). Meteora's 2-layer
///   topology also uses this — the "backend" slot simply holds address(0)
///   when the adapter is end-to-end.
abstract contract CpiAdapterBase is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────────

    event BackendUpdated(address indexed previous, address indexed next);

    // ──────────────────────────────────────────────────────────────────
    // State
    // ──────────────────────────────────────────────────────────────────

    address public backend;

    // ──────────────────────────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────────────────────────

    /// @param initialOwner Deployment-time owner. Usually the deployer;
    ///        production can transferOwnership to a multisig afterwards.
    constructor(address initialOwner) Ownable(initialOwner) {}

    // ──────────────────────────────────────────────────────────────────
    // Owner controls
    // ──────────────────────────────────────────────────────────────────

    function setBackend(address newBackend) external onlyOwner {
        address prev = backend;
        backend = newBackend;
        emit BackendUpdated(prev, newBackend);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// Rescue ERC20 tokens accidentally sent to the adapter. Owner-gated.
    function withdrawERC20(IERC20 token, uint256 amount) external onlyOwner {
        token.safeTransfer(msg.sender, amount);
    }

    // ──────────────────────────────────────────────────────────────────
    // Internal helpers
    // ──────────────────────────────────────────────────────────────────

    /// Revert `CpiError.AmountTooLarge(value)` if `value > type(uint64).max`.
    /// Every uint256 the adapter passes into a Solana u64 field must go
    /// through this guard.
    function _u64check(uint256 value) internal pure returns (uint64) {
        if (value > type(uint64).max) {
            revert CpiError.AmountTooLarge(value);
        }
        return uint64(value);
    }
}
