// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HelperProgram} from "../interface.sol";
import {AccountReader} from "../cpi/AccountReader.sol";
import {SPL_ERC20, ERC20Users} from "../erc20spl/erc20spl.sol";

/// @title SimpleActivator
/// @notice One-tx, user-paid first-time account-bootstrap entry point. A
///         fresh EVM address gets everything needed to transact on this
///         Rome chain in a single `activate{value: activationCost}()`
///         call:
///
///           1. User's unified `external_auth` PDA created + funded
///              with `USER_PDA_FUNDING` lamports (rent floor + 2 ATA
///              rents + ~5 fresh-recipient-transfer reserve).
///           2. wUSDC ATA created, owned by the user's PDA.
///           3. wSOL ATA created, owned by the user's PDA.
///           4. User registered in BOTH wrappers' `ERC20Users` mapping,
///              so wrapper writes (`transfer` / `approve` / `transferFrom`)
///              and DEX swaps resolve `users.get_user(msg.sender)`
///              without reverting.
///
///         Replaces the previous three-call flow (`activate()` +
///         `createWusdcAta()` + `createWsolAta()`). Per the
///         `0xfC07E2Bc9F1179fB567298C4C570C6fFf28980d1` probe on Hadrian
///         (2026-05-15) the combined 5-CPI tx (create_pda + 2× create_ata
///         + 2× ensure_user) consumes ~234K Solana CU mean (range
///         218-256K) — 83% headroom under the 1.4M cap. The win over
///         the prior 3-call flow is twofold: (a) Rome's per-tx envelope
///         (~200K CU) paid ONCE instead of 3× — that's ~400K CU
///         eliminated. (b) Single MetaMask popup, single user wait —
///         dramatically better activation UX.
///
/// @dev    `activate()` is non-idempotent: re-running on an already-
///         activated address reverts. Callers MUST gate on
///         `isActivated(msg.sender)` first — the rome-ui
///         ActivateAccountButton already does this via `useIsPdaActivated`.
///
///         The `USER_PDA_FUNDING` lamports include 2× ATA rent so the
///         user's PDA has enough lamports to fund subsequent ATA-creates
///         when the user issues `bridgeOutToSolana` (or any other flow
///         that ATA-creates on behalf of a fresh recipient). Plus a
///         `FRESH_TRANSFER_RESERVE` for ~5 follow-on creates before the
///         user has to call `topUpUserPda` to refill.
contract SimpleActivator {
    /// @notice Rent-exempt floor for a System Program 0-byte account
    ///         (the user's `external_auth` PDA). Verified against
    ///         `RomeEVMAccount.minimum_balance(0)` in rome-evm-private.
    ///         (128 + 0) * 3480 * 2 = 890_880 lamports.
    uint64 public constant PDA_RENT_LAMPORTS = 890_880;

    /// @notice Rent-exempt floor for an SPL Token Account (165 bytes).
    ///         (128 + 165) * 3480 * 2 = 2_039_280 lamports. Used twice:
    ///         once for wUSDC ATA, once for wSOL ATA — both funded out
    ///         of the user's PDA at activation time.
    uint64 public constant ATA_RENT_LAMPORTS = 2_039_280;

    /// @notice Lamports kept in the user's PDA as a reserve for
    ///         downstream fresh-recipient ATA-creates (e.g. first
    ///         `bridgeOutToSolana` to a wallet without the wrapper's
    ///         ATA on Solana, first `transfer` to a fresh EVM address).
    ///         Sized for ~5 such creates: 10_000_000 / 2_039_280 ≈ 4.9.
    ///         When drained, user calls `topUpUserPda{value: ...}()` to
    ///         refill.
    uint64 public constant FRESH_TRANSFER_RESERVE = 10_000_000;

    /// @notice Total lamports the user's `external_auth` PDA receives
    ///         at activation time:
    ///           PDA_RENT (rent-exempt floor)
    ///         + 2 × ATA_RENT (wUSDC + wSOL ATA rents)
    ///         + FRESH_TRANSFER_RESERVE.
    ///         = 14_969_440 lamports ≈ 0.015 SOL.
    uint64 public constant USER_PDA_FUNDING =
        PDA_RENT_LAMPORTS + 2 * ATA_RENT_LAMPORTS + FRESH_TRANSFER_RESERVE;

    /// @notice Wei the caller must pay per `activate()`. Strict equality —
    ///         no overpay refund. Caller reads this view first and
    ///         passes exactly this amount. Sized in native gas (USDC on
    ///         Rome) to recoup the operator's SOL outflow that
    ///         `HelperProgram.create_pda` will draw from. Sybil-
    ///         resistance margin baked in: zero operator subsidy.
    uint256 public immutable activationCost;

    /// @notice wUSDC wrapper (chain's gas-mint SPL_ERC20).
    SPL_ERC20 public immutable wusdcWrapper;

    /// @notice wSOL wrapper (canonical wSOL SPL_ERC20).
    SPL_ERC20 public immutable wsolWrapper;

    /// @notice Shared ERC20Users contract — registers user PDAs so
    ///         downstream wrapper / DEX calls can `get_user(msg.sender)`
    ///         without reverting with "User does not exist". Both
    ///         `wusdcWrapper` and `wsolWrapper` consult this same
    ///         contract (instantiated by `ERC20SPLFactory` at chain
    ///         bring-up and shared across all factory-deployed wrappers).
    ERC20Users public immutable users;

    /// @notice The wUSDC wrapper's underlying SPL mint pubkey. Captured
    ///         at construction so `activate()` can pass it to
    ///         `HelperProgram.create_ata(user, mint)` without an extra
    ///         CPI round-trip to `wusdcWrapper.mint_id()`.
    bytes32 public immutable usdcMint;

    /// @notice The wSOL wrapper's underlying SPL mint pubkey. Same role
    ///         as `usdcMint` for the wSOL ATA.
    bytes32 public immutable wsolMint;

    error InvalidPayment(uint256 sent, uint256 required);
    error AlreadyActivated(address user);
    error CpiFailed(string call);

    event Activated(address indexed user, uint256 paid);
    event UserPdaToppedUp(address indexed user, uint256 paid);

    constructor(
        uint256 _activationCost,
        SPL_ERC20 _wusdcWrapper,
        SPL_ERC20 _wsolWrapper,
        ERC20Users _users
    ) {
        activationCost = _activationCost;
        wusdcWrapper = _wusdcWrapper;
        wsolWrapper = _wsolWrapper;
        users = _users;
        // Cache underlying mints so per-call `mint_id()` reads are avoided.
        usdcMint = _wusdcWrapper.mint_id();
        wsolMint = _wsolWrapper.mint_id();
    }

    /// @notice One-tx activation. Caller pays `activationCost` in native
    ///         gas; in exchange gets a funded `external_auth` PDA plus
    ///         wUSDC + wSOL ATAs plus ERC20Users registrations.
    ///
    /// Reverts:
    ///   - `InvalidPayment` if `msg.value` doesn't EXACTLY match
    ///     `activationCost` (strict equality — caller pre-reads).
    ///   - `AlreadyActivated` if the user's PDA already has lamports
    ///     (re-activation is a no-op user error; caller should gate on
    ///     `isActivated` first).
    ///   - `CpiFailed` if any of the 5 CPIs fails. The 5-CPI tx has been
    ///     measured at 234K Solana CU mean on Hadrian — 83% headroom.
    function activate() external payable {
        address user = msg.sender;

        // Strict-equality msg.value gate. Caller is expected to read
        // `activationCost()` first and pass exactly that. Strict because
        // a forgiving gate + refund path adds complexity for zero UX
        // benefit (caller already knows the price; underpay = revert,
        // overpay = also revert, no surprises).
        if (msg.value != activationCost) {
            revert InvalidPayment(msg.value, activationCost);
        }

        // Activation idempotency check: `HelperProgram.create_pda(user,
        // lamports)` calls the System Program's `CreateAccount` ix,
        // which FAILS if the account already exists. So we must gate
        // here. UI surfaces this via `isActivated` before showing the
        // Activate CTA.
        bytes32 userPda = HelperProgram.pda(user);
        if (AccountReader.lamportsOf(userPda) > 0) {
            revert AlreadyActivated(user);
        }

        // CPI 1 — create + fund the user's external_auth PDA with the
        // full funding budget (rent + 2× ATA rent + fresh-transfer
        // reserve). The signer (rome operator) pays the SOL outflow;
        // the user reimburses via the activationCost gas debit absorbed
        // at the EVM-tx layer.
        (bool ok1, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_pda(address,uint64)",
                user,
                USER_PDA_FUNDING
            )
        );
        if (!ok1) revert CpiFailed("create_pda");

        // CPI 2 — create the user's wUSDC ATA. Idempotent in
        // rome-evm-private's `create_ata_internal` — it issues
        // `create_associated_token_account_idempotent`, so a re-run
        // (defensive) is a no-op.
        (bool ok2, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata(address,bytes32)",
                user,
                usdcMint
            )
        );
        if (!ok2) revert CpiFailed("create_ata(wUSDC)");

        // CPI 3 — same for wSOL ATA.
        (bool ok3, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata(address,bytes32)",
                user,
                wsolMint
            )
        );
        if (!ok3) revert CpiFailed("create_ata(wSOL)");

        // CPI 4 + 5 — register user in both wrappers' ERC20Users
        // mappings. Single shared `users` contract (instantiated by
        // ERC20SPLFactory at chain bring-up and shared across all
        // factory-deployed wrappers — so wusdcWrapper._users ==
        // wsolWrapper._users == this contract's `users` field), but
        // we follow the convention of treating each wrapper's mapping
        // independently in case the factory layout ever changes. The
        // mapping write inside `ensure_user` is idempotent — a re-run
        // returns the existing entry and writes nothing.
        users.ensure_user(user);

        emit Activated(user, msg.value);
    }

    /// @notice Refill the user's `external_auth` PDA reserve. Callers
    ///         use this after the FRESH_TRANSFER_RESERVE has been
    ///         drained by ~5 fresh-recipient bridgeOutToSolana /
    ///         transfer-to-fresh-address calls.
    ///
    ///         msg.value of any positive amount is accepted; the value
    ///         is converted to SOL lamports via
    ///         `HelperProgram.swap_gas_to_lamports` and credited to the
    ///         caller's PDA.
    ///
    /// @dev    `swap_gas_to_lamports(lamports)` is invoked via
    ///         `delegatecall`, so the precompile sees `caller =
    ///         msg.sender` (the activating user, NOT this contract).
    ///         The operator (signer) sends lamports to
    ///         `external_auth(msg.sender)`; the user's gas is debited
    ///         at the EVM-tx layer to cover the swap.
    ///
    ///         The user passes a `lamports` amount that matches the
    ///         msg.value they want to spend; we don't auto-convert
    ///         here because the gas-to-SOL rate is operator-set and
    ///         exposing it to per-call arithmetic invites discrepancy.
    ///         UI computes lamports server-side from the operator's
    ///         current rate and passes both.
    function topUpUserPda(uint64 lamports) external payable {
        if (msg.value == 0) {
            revert InvalidPayment(0, 1);
        }

        // CPI — burn user's gas via swap_gas_to_lamports + credit
        // user's PDA with `lamports`. Signed as `external_auth(user)`.
        // The msg.value at the EVM layer pays for the gas (operator's
        // SOL outflow recoup); `lamports` is the actual SOL credit
        // landing in the PDA.
        (bool ok, ) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "swap_gas_to_lamports(uint64)",
                lamports
            )
        );
        if (!ok) revert CpiFailed("swap_gas_to_lamports");

        emit UserPdaToppedUp(msg.sender, msg.value);
    }

    /// @notice True iff the user has been fully activated — their
    ///         `external_auth` PDA exists on Solana AND both the wUSDC
    ///         and wSOL ATAs exist.
    ///
    ///         Three lamport reads via the
    ///         `AccountReader.lamportsOf` (cheap — no data buffer pull,
    ///         no Borsh decode). The AND-of-three predicate forces a
    ///         re-run of `activate()` if any of the three creates
    ///         partially succeeded — but in practice
    ///         `activate()`'s in-tx CPI sequence is atomic (any failure
    ///         reverts the entire tx), so partial-state should never
    ///         occur in normal operation.
    function isActivated(address user) external view returns (bool) {
        bytes32 userPda = HelperProgram.pda(user);
        if (AccountReader.lamportsOf(userPda) == 0) {
            return false;
        }
        bytes32 wusdcAta = HelperProgram.ata(user, usdcMint);
        if (AccountReader.lamportsOf(wusdcAta) == 0) {
            return false;
        }
        bytes32 wsolAta = HelperProgram.ata(user, wsolMint);
        if (AccountReader.lamportsOf(wsolAta) == 0) {
            return false;
        }
        return true;
    }
}
