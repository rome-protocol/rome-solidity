// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICrossProgramInvocation, CpiProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {SPL_ERC20, ERC20Users} from "../erc20spl/erc20spl.sol";

/// @title SimpleActivator
/// @notice Three-step "Activate your account" entry. Sets up everything
///         the user needs to transact on this chain. Split into three
///         calls because each ATA-create + activator-PDA-topup CPI pair
///         consumes ~950k CU on Solana, and bundling two ATA creates in
///         one tx (~1.65M CU) exceeds the 1.4M-CU per-tx cap. Each call
///         below stays well under the cap; the UI fires them sequentially
///         behind one button.
///
///         Step 1 — `activate()`:
///           1. User's unified PDA — funded at the rent-exempt floor
///              (890,880 lamports = lifetime rent-free).
///           2. User registered in the `ERC20Users` mapping so wrapper
///              writes (transfer / approve / transferFrom) and DEX swaps
///              find their PDA via `users.get_user(msg.sender)`.
///
///         Step 2 — `createWusdcAta()`:
///           1. THIS contract's PDA topped up so it can pay rent.
///           2. User's WUSDC ATA — owned by the user's PDA, rent-exempt.
///
///         Step 3 — `createWsolAta()`:
///           1. THIS contract's PDA topped up (idempotent).
///           2. User's WSOL ATA — owned by the user's PDA, rent-exempt.
///
///         All three Solana accounts are rent-exempt: the lamports stay
///         indefinitely, no rent ever accrues, and the user can fully
///         use the chain without any further bootstrap.
///
/// @dev    Each function is idempotent:
///           - `activate()` short-circuits + refunds if user PDA already
///             has lamports. `AlreadyActivated` is emitted.
///           - `createWusdcAta()` / `createWsolAta()` are naturally
///             idempotent — `create_payer` and `ensure_token_account`
///             both short-circuit on Solana when the target state is
///             already met. Re-running them costs the user gas + the
///             tokenAccountsCost but creates no new state.
contract SimpleActivator {
    /// @notice Wei the caller must pay per `activate()`.
    uint256 public immutable activationCost;

    /// @notice Wei the caller must pay per `createWusdcAta()` /
    ///         `createWsolAta()` call. Sized to cover the operator's
    ///         per-call SOL outflow (~2M lamports for the ATA rent +
    ///         activator PDA topup) plus a small Sybil-resistance margin.
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
    ///         createWusdcAta / createWsolAta call. Sized to cover its
    ///         own rent-exempt floor PLUS one ATA-create rent
    ///         (2,039,280) per call, with a small buffer.
    uint64 public constant ACTIVATOR_PDA_BUFFER = 5_000_000;

    error InsufficientGas(uint256 sent, uint256 required);
    error RefundFailed();

    event Activated(address indexed user, uint256 paid);
    event AlreadyActivated(address indexed user, uint256 refunded);
    event WusdcAtaCreated(address indexed user, uint256 paid);
    event WsolAtaCreated(address indexed user, uint256 paid);

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

    /// @notice Step 2 of activation. Tops up THIS contract's PDA (so it
    ///         can pay the WUSDC ATA rent), then creates the user's
    ///         WUSDC ATA owned by the user's PDA. Idempotent — both
    ///         `create_payer` and `ensure_token_account` short-circuit
    ///         on Solana when the target state is already met.
    function createWusdcAta() external payable {
        address user = msg.sender;

        if (msg.value < tokenAccountsCost) {
            revert InsufficientGas(msg.value, tokenAccountsCost);
        }

        RomeEVMAccount.create_payer(address(this), ACTIVATOR_PDA_BUFFER);
        usdcWrapper.ensure_token_account(user);

        emit WusdcAtaCreated(user, msg.value);
    }

    /// @notice Step 3 of activation. Same pattern as step 2 but for the
    ///         WSOL ATA.
    function createWsolAta() external payable {
        address user = msg.sender;

        if (msg.value < tokenAccountsCost) {
            revert InsufficientGas(msg.value, tokenAccountsCost);
        }

        RomeEVMAccount.create_payer(address(this), ACTIVATOR_PDA_BUFFER);
        wsolWrapper.ensure_token_account(user);

        emit WsolAtaCreated(user, msg.value);
    }

    /// @notice True if the user's PDA already has lamports — i.e., the
    ///         activate() call should NOT appear again. The UI also probes
    ///         Solana directly for the WUSDC and WSOL ATAs to decide
    ///         whether step 2 / step 3 are still needed.
    function isActivated(address user) external view returns (bool) {
        bytes32 userPda = RomeEVMAccount.pda(user);
        return CpiProgram.account_lamports(userPda) > 0;
    }
}
