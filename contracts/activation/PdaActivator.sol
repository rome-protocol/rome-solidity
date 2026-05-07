// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SPL_ERC20} from "../erc20spl/erc20spl.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {ICrossProgramInvocation, CpiProgram, WrapGasToSpl} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";

/// @notice Minimal Romeswap router surface — only the one method the
///         activator calls. Inlined to avoid a cross-repo import on
///         rome-uniswap-v2; Solidity ABI is stable.
interface IUniswapV2RouterMinimal {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

/// @title PdaActivator
/// @notice One-step "Activate your account" entry point. Charges the
///         user in native gas, swaps a sliver via the Romeswap WUSDC↔WSOL
///         pool, then closes the resulting wSOL ATA into the user's
///         unified PDA — landing real SOL lamports there. Idempotent:
///         refunds msg.value cleanly if the PDA is already activated.
///
/// @dev    Mechanism (zero rome-evm-private change, zero new precompile):
///           1. Activator receives msg.value gas (held in its
///              `address(this).balance`).
///           2. `wrap_gas_to_spl(msg.value)` (regular call — delegatecall
///              is forbidden for that precompile; see
///              rome-evm-private/program/src/non_evm/wrap_gas_to_spl.rs:55):
///              converts activator's gas → WUSDC SPL into activator's
///              PDA-ATA, paid by `state.signer()` for the ATA-create
///              if needed.
///           3. `usdcWrapper.approve(router, wusdcAmount)`. First-ever
///              call also triggers `ERC20Users.ensure_user(activator)`,
///              which registers the activator in the wrapper's `users`
///              mapping (no PDA funding — that's the user's job, paid
///              via this very swap).
///           4. `router.swapExactTokensForTokens(WUSDC → WSOL, to=user)`.
///              `wsolWrapper._transfer` creates user's wSOL ATA on first
///              transfer (rent paid by activator's PDA via
///              `ensure_token_account`). Output wSOL lands in user's
///              PDA-owned wSOL ATA.
///           5. CPI `invoke_signed(closeAccount, user's wSOL ATA,
///              dest=user's unified PDA)` via `address(CpiProgram).delegatecall`.
///              Delegatecall preserves `msg.sender = user` so the precompile
///              auto-signs as `external_auth(user)`. closeAccount transfers
///              all lamports (rent reserve + wrapped SOL value) to the
///              user's PDA. Result: PDA exists on Solana with lamports
///              ≥ rent-exempt floor + wrapped value, owner = system_program.
///
/// @dev    Per-user cost = `activationCost` worth of native gas (debited
///         on first call; refunded if PDA is already activated).
///         Per-deployment one-time operator cost = ~50M lamports for
///         activator's PDA bootstrap (via `ensure_user` chain).
///         Sybil resistance: user pays the swap themselves; pool
///         provides liquidity; operator only seeds initial pool.
contract PdaActivator {
    SPL_ERC20 public immutable usdcWrapper;
    SPL_ERC20 public immutable wsolWrapper;
    IUniswapV2RouterMinimal public immutable router;
    bytes32 public immutable wsolMint;
    bytes32 public immutable splTokenProgram;

    /// @notice Native-gas wei the caller must supply per activation.
    ///         Sized off-chain so that after pool slippage the user's
    ///         PDA receives ~10M lamports (rent-exempt floor + a small
    ///         buffer for ATA creates). Topping up beyond this is the
    ///         user's responsibility (e.g., direct SOL transfer to the
    ///         PDA address from a Solana wallet).
    uint256 public immutable activationCost;

    /// @notice usdcWrapper has 6 decimals on chain mints we target;
    ///         native gas wei is 18 decimals. Conversion factor is
    ///         10^(18 - 6) = 10^12. Captured at construction so the
    ///         contract is reusable for any USDC-gas chain even if a
    ///         future wrapper picks different decimals.
    uint256 public immutable wusdcDecimalsScale;

    error InsufficientGas(uint256 sent, uint256 required);
    error CpiCloseFailed(bytes reason);
    error RefundFailed();

    event Activated(address indexed user, uint256 paid, uint256 wsolReceived);
    event AlreadyActivated(address indexed user, uint256 refunded);

    constructor(
        SPL_ERC20 _usdcWrapper,
        SPL_ERC20 _wsolWrapper,
        IUniswapV2RouterMinimal _router,
        bytes32 _wsolMint,
        bytes32 _splTokenProgram,
        uint256 _activationCost
    ) {
        usdcWrapper = _usdcWrapper;
        wsolWrapper = _wsolWrapper;
        router = _router;
        wsolMint = _wsolMint;
        splTokenProgram = _splTokenProgram;
        activationCost = _activationCost;

        // Native gas wei (18 decimals) → USDC base units (6 decimals).
        // Hardcoded for USDC; if a chain ever uses a different decimals
        // gas-mint we'll subclass or parameterize.
        wusdcDecimalsScale = 10 ** (18 - 6);
    }

    /// @notice Activate the caller's unified PDA on this Rome chain.
    ///         Idempotent: refunds msg.value cleanly if PDA already has
    ///         lamports (no revert; the tx still lands).
    /// @param  minWsolOut Slippage protection. Caller computes via
    ///         `router.getAmountsOut(activationCost / wusdcDecimalsScale,
    ///         [WUSDC, WSOL])` then applies tolerance. Reverts if the
    ///         pool returns less.
    function activate(uint256 minWsolOut) external payable {
        address user = msg.sender;
        bytes32 userPda = RomeEVMAccount.pda(user);

        // 1. Idempotency check. PDA already has lamports → refund and
        //    exit cleanly. Read-only precompile, cheap.
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

        // 2. Wrap activator's gas → WUSDC SPL in activator's PDA-ATA.
        //    Regular call (delegatecall is rejected by the precompile).
        WrapGasToSpl.wrap_gas_to_spl(msg.value);

        uint256 wusdcAmount = msg.value / wusdcDecimalsScale;

        // 3. Approve router. First call also registers the activator in
        //    the wrapper's `users` mapping via ERC20Users.ensure_user —
        //    no PDA funding side-effect after the operator-subsidy
        //    cleanup.
        usdcWrapper.approve(address(router), wusdcAmount);

        // 4. Swap WUSDC → WSOL via Romeswap. Output goes to user's
        //    wSOL wrapper ATA (wsolWrapper._transfer auto-creates the
        //    ATA on the recipient if it doesn't exist).
        address[] memory path = new address[](2);
        path[0] = address(usdcWrapper);
        path[1] = address(wsolWrapper);
        uint256[] memory amounts = router.swapExactTokensForTokens(
            wusdcAmount,
            minWsolOut,
            path,
            user,
            block.timestamp + 60
        );
        uint256 wsolReceived = amounts[amounts.length - 1];

        // 5. closeAccount on user's wSOL ATA, destination = user's PDA.
        //    All lamports (rent reserve + wrapped SOL value) flow to
        //    the PDA via the System::transfer that closeAccount
        //    triggers internally.
        bytes32 wsolAta = CpiProgram.derive_user_ata(user, wsolMint);

        bytes32[] memory noSigners = new bytes32[](0);
        (
            bytes32 progId,
            ICrossProgramInvocation.AccountMeta[] memory metas,
            bytes memory data
        ) = SplTokenLib.close_account(
            splTokenProgram,
            wsolAta,
            userPda,    // destination — receives all lamports
            userPda,    // owner — signed by precompile via delegatecall
            noSigners
        );

        // Delegatecall preserves msg.sender = user, so the CPI
        // precompile auto-signs the closeAccount as external_auth(user).
        // No salts needed — the unified PDA seed is `[EXTERNAL_AUTHORITY,
        // user_h160]`, derived from the preserved caller.
        bytes32[] memory salts = new bytes32[](0);
        (bool ok, bytes memory result) = address(CpiProgram).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                progId,
                metas,
                data,
                salts
            )
        );
        if (!ok) revert CpiCloseFailed(result);

        emit Activated(user, msg.value, wsolReceived);
    }

    /// @notice View helper for the UI — returns true if the caller's
    ///         unified PDA already has lamports (i.e., is activated).
    ///         Source-of-truth probe; matches the Activate-button
    ///         visibility gate in rome-ui.
    function isActivated(address user) external view returns (bool) {
        bytes32 userPda = RomeEVMAccount.pda(user);
        return CpiProgram.account_lamports(userPda) > 0;
    }
}
