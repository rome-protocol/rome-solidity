// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICrossProgramInvocation, CpiProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {SPL_ERC20, ERC20Users} from "../erc20spl/erc20spl.sol";

/// @title SimpleActivator
/// @notice Two-step "Activate your account" entry. Sets up everything the
///         user needs to transact on this chain. Split into two calls
///         because the full flow (PDA fund + ensure_user + 2 ATAs)
///         exceeds Solana's 1.4M-CU per-tx cap when packed into a single
///         atomic EVM tx (~2M CU emulated). Each call below stays under
///         the cap; the UI fires them back-to-back behind one button.
///
///         Step 1 — `activate()`:
///           1. User's unified PDA — funded at the rent-exempt floor
///              (890,880 lamports = lifetime rent-free).
///           2. User registered in the `ERC20Users` mapping so wrapper
///              writes (transfer / approve / transferFrom) and DEX swaps
///              find their PDA via `users.get_user(msg.sender)`.
///
///         Step 2 — `createTokenAccounts()`:
///           1. THIS contract's PDA topped up so it can pay rent.
///           2. User's WUSDC ATA — owned by the user's PDA, rent-exempt.
///           3. User's WSOL ATA — owned by the user's PDA, rent-exempt.
///
///         All three Solana accounts are rent-exempt: the lamports stay
///         indefinitely, no rent ever accrues, and the user can fully
///         use the chain without any further bootstrap.
///
/// @dev    Each function is idempotent:
///           - `activate()` short-circuits + refunds if user PDA already
///             has lamports. `AlreadyActivated` is emitted.
///           - `createTokenAccounts()` is naturally idempotent —
///             `create_payer` and `ensure_token_account` both short-
///             circuit when the target state is already met.
contract SimpleActivator {
    /// @notice Wei the caller must pay per `activate()`.
    uint256 public immutable activationCost;

    /// @notice Wei the caller must pay per `createTokenAccounts()`.
    uint256 public immutable tokenAccountsCost;

    /// @notice WUSDC wrapper (chain's gas-mint SPL_ERC20).
    SPL_ERC20 public immutable usdcWrapper;

    /// @notice WSOL wrapper (canonical wSOL SPL_ERC20).
    SPL_ERC20 public immutable wsolWrapper;

    /// @notice Shared ERC20Users contract — registers user PDAs so
    ///         downstream wrapper / DEX calls can `get_user(msg.sender)`
    ///         without reverting with "User does not exist".
    ERC20Users public immutable users;

    /// @notice Lamports the operator transfers to a fresh user PDA.
    ///         (128 + 0) * 3480 * 2 = 890,880 — rent-exempt floor for an
    ///         empty system-owned account.
    uint64 public constant PDA_RENT_LAMPORTS = 890_880;

    /// @notice Lamports the operator tops THIS contract's PDA up to per
    ///         createTokenAccounts call, sized to cover its own rent-
    ///         exempt floor PLUS two ATA-create rents (2 × 2,039,280 =
    ///         4,078,560), with a small buffer.
    uint64 public constant ACTIVATOR_PDA_BUFFER = 5_000_000;

    error InsufficientGas(uint256 sent, uint256 required);
    error RefundFailed();

    event Activated(address indexed user, uint256 paid);
    event AlreadyActivated(address indexed user, uint256 refunded);
    event TokenAccountsCreated(address indexed user, uint256 paid);

    constructor(
        uint256 _activationCost,
        uint256 _tokenAccountsCost,
        SPL_ERC20 _usdcWrapper,
        SPL_ERC20 _wsolWrapper,
        ERC20Users _users
    ) {
        activationCost = _activationCost;
        tokenAccountsCost = _tokenAccountsCost;
        usdcWrapper = _usdcWrapper;
        wsolWrapper = _wsolWrapper;
        users = _users;
    }

    /// @notice Step 1 of activation. Funds the user's PDA at the rent-
    ///         exempt floor and registers the user in the ERC20Users
    ///         mapping. After this, downstream wrapper / DEX calls
    ///         resolve `users.get_user(msg.sender)` correctly.
    ///
    ///         Idempotent: if the user PDA already has lamports, msg.value
    ///         is refunded and `AlreadyActivated` is emitted.
    function activate() external payable {
        address user = msg.sender;
        bytes32 userPda = RomeEVMAccount.pda(user);

        uint64 currentLamports = CpiProgram.account_lamports(userPda);
        if (currentLamports > 0) {
            (bool refundOk, ) = payable(user).call{value: msg.value}("");
            if (!refundOk) revert RefundFailed();
            emit AlreadyActivated(user, msg.value);
            return;
        }

        if (msg.value < activationCost) {
            revert InsufficientGas(msg.value, activationCost);
        }

        RomeEVMAccount.create_payer(user, PDA_RENT_LAMPORTS);
        users.ensure_user(user);

        emit Activated(user, msg.value);
    }

    /// @notice Step 2 of activation. Tops up THIS contract's PDA so it
    ///         can pay ATA rents, then creates the user's WUSDC and WSOL
    ///         ATAs. Idempotent — both `create_payer` and
    ///         `ensure_token_account` short-circuit when the target
    ///         state is already met. Safe to retry without effect.
    ///
    ///         Caller does NOT need to be activated first — these calls
    ///         just create ATAs owned by `RomeEVMAccount.pda(user)`,
    ///         which is a deterministic address regardless of activation
    ///         state. But in practice the UI always calls activate() first.
    function createTokenAccounts() external payable {
        address user = msg.sender;

        if (msg.value < tokenAccountsCost) {
            revert InsufficientGas(msg.value, tokenAccountsCost);
        }

        RomeEVMAccount.create_payer(address(this), ACTIVATOR_PDA_BUFFER);
        usdcWrapper.ensure_token_account(user);
        wsolWrapper.ensure_token_account(user);

        emit TokenAccountsCreated(user, msg.value);
    }

    /// @notice True if the user's PDA already has lamports — i.e., the
    ///         activate() call should NOT appear again.
    function isActivated(address user) external view returns (bool) {
        bytes32 userPda = RomeEVMAccount.pda(user);
        return CpiProgram.account_lamports(userPda) > 0;
    }
}
