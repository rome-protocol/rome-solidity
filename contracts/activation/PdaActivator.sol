// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SPL_ERC20} from "../erc20spl/erc20spl.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {ICrossProgramInvocation, CpiProgram, WrapGasToSpl} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";

/// @notice Minimal Meteora DAMMv1Pool surface — only the swap method
///         the activator calls. The full pool contract lives in
///         contracts/meteora/damm_v1_pool.sol; we only need this
///         function to keep the activator's bytecode small.
interface IMeteoraDAMMv1PoolMinimal {
    function swapExactTokensForTokens(
        address token_in,
        uint256 amount_in,
        uint256 min_amount_out
    ) external;
}

/// @title PdaActivator
/// @notice One-step "Activate your account" entry point. Takes the
///         user's native gas, swaps a sliver via the chain's existing
///         Meteora gas-pricing DAMMv1Pool (the same pool the proxy's
///         price-manager reads + the same one the operator used at
///         /prepare-rollup time to bootstrap gas-token pricing), then
///         closes the resulting wSOL ATA into the user's unified PDA.
///         User pays in their own gas; zero operator subsidy. Idempotent.
///
/// @dev    Mechanism (uses only existing chain primitives — Meteora
///         pool plumbed during /prepare-rollup, WSOL wrapper +
///         DAMMv1Pool Solidity wrapper added at /bring-up-chain Row 6):
///           1. Activator receives msg.value gas (held in
///              `address(this).balance` as native USDC).
///           2. `wrap_gas_to_spl(msg.value)` (regular call — delegatecall
///              is forbidden by that precompile) converts activator's
///              gas → WUSDC SPL into activator's PDA-ATA. ATA-create
///              cost is paid by `state.signer()` (proxy payer) if the
///              ATA doesn't yet exist.
///           3. `usdcWrapper.approve(meteoraPool, wusdcAmount)`. First-
///              ever call also triggers `ERC20Users.ensure_user(activator)`
///              which registers the activator in the wrapper's `users`
///              mapping — purely mapping-only after the operator-subsidy
///              cleanup.
///           4. `meteoraPool.swapExactTokensForTokens(usdcWrapper,
///              wusdcAmount, minWsolOut)`. The pool's swap CPIs into
///              the on-chain Meteora program with `users.get_user(activator)`
///              = activator's PDA as the swap initiator; output wSOL SPL
///              lands in activator's PDA-owned wSOL ATA.
///           5. CPI `invoke_signed(closeAccount, activator's wSOL ATA,
///              dest=user's unified PDA, owner=activator's PDA)`. Regular
///              call (not delegatecall) so the precompile signs as
///              `external_auth(activator)` matching the wSOL ATA owner.
///              closeAccount transfers all lamports (rent reserve +
///              wrapped SOL value) to the user's PDA via System::transfer.
///              Result: PDA exists on Solana with lamports ≥ rent-exempt
///              floor, owner = system_program.
///
/// @dev    Per-user cost = `activationCost` worth of native gas
///         (debited on first call; refunded if PDA is already activated).
///         Per-deployment one-time operator cost = ~50M lamports for
///         activator's PDA bootstrap (via ensure_user on first call).
///         Sybil resistance: user pays the swap themselves; no operator
///         subsidy. Pool liquidity is the chain's gas-pricing pool which
///         exists for unrelated reasons (oracle pricing) — activator
///         users contribute swap fees back to the same pool.
contract PdaActivator {
    SPL_ERC20 public immutable usdcWrapper;
    SPL_ERC20 public immutable wsolWrapper;
    IMeteoraDAMMv1PoolMinimal public immutable meteoraPool;
    bytes32 public immutable wsolMint;
    bytes32 public immutable splTokenProgram;

    /// @notice Native-gas wei the caller must supply per activation.
    ///         Sized off-chain so that after pool slippage the user's
    ///         PDA receives ~10M lamports (rent-exempt floor + a small
    ///         buffer for ATA creates).
    uint256 public immutable activationCost;

    /// @notice usdcWrapper has 6 decimals on USDC-gas chains; native gas
    ///         wei is 18 decimals. Conversion factor is 10^(18 - 6).
    uint256 public immutable wusdcDecimalsScale;

    error InsufficientGas(uint256 sent, uint256 required);
    error CpiCloseFailed(bytes reason);
    error RefundFailed();

    event Activated(address indexed user, uint256 paid, uint256 wsolReceived);
    event AlreadyActivated(address indexed user, uint256 refunded);

    constructor(
        SPL_ERC20 _usdcWrapper,
        SPL_ERC20 _wsolWrapper,
        IMeteoraDAMMv1PoolMinimal _meteoraPool,
        bytes32 _wsolMint,
        bytes32 _splTokenProgram,
        uint256 _activationCost
    ) {
        usdcWrapper = _usdcWrapper;
        wsolWrapper = _wsolWrapper;
        meteoraPool = _meteoraPool;
        wsolMint = _wsolMint;
        splTokenProgram = _splTokenProgram;
        activationCost = _activationCost;

        // Native gas wei (18 decimals) → USDC base units (6 decimals).
        // Hardcoded for USDC-gas chains; if a chain ever uses a different
        // decimals gas-mint we'll subclass or parameterize.
        wusdcDecimalsScale = 10 ** (18 - 6);
    }

    /// @notice Activate the caller's unified PDA on this Rome chain.
    ///         Idempotent: refunds msg.value cleanly if PDA already has
    ///         lamports (no revert; the tx still lands).
    /// @param  minWsolOut Slippage protection. Caller computes off-chain
    ///         from the pool's reserves + tolerance. Reverts if the pool
    ///         returns less.
    function activate(uint256 minWsolOut) external payable {
        address user = msg.sender;
        bytes32 userPda = RomeEVMAccount.pda(user);

        // 1. Idempotency check. PDA already has lamports → refund + exit.
        //    Read-only precompile, cheap.
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

        // 3. Approve Meteora pool to spend activator's WUSDC. First call
        //    also registers activator in ERC20Users mapping (mapping-only
        //    after operator-subsidy cleanup).
        usdcWrapper.approve(address(meteoraPool), wusdcAmount);

        // 4. Swap WUSDC → WSOL via the chain's existing Meteora gas-
        //    pricing pool. Swap signs as activator's PDA on Solana side
        //    via DAMMv1Pool's internal CPI dispatcher; output lands in
        //    activator's PDA-owned wSOL ATA.
        meteoraPool.swapExactTokensForTokens(
            address(usdcWrapper),
            wusdcAmount,
            minWsolOut
        );

        // 5. closeAccount on activator's wSOL ATA, destination = user's
        //    unified PDA. Regular call to CpiProgram (not delegatecall)
        //    so the precompile auto-signs as external_auth(activator),
        //    matching the wSOL ATA's owner. All lamports (rent reserve
        //    + wrapped SOL value) flow to the user's PDA via the
        //    System::transfer that closeAccount triggers internally.
        bytes32 wsolAta = CpiProgram.derive_user_ata(address(this), wsolMint);
        bytes32 activatorPda = RomeEVMAccount.pda(address(this));

        bytes32[] memory noSigners = new bytes32[](0);
        (
            bytes32 progId,
            ICrossProgramInvocation.AccountMeta[] memory metas,
            bytes memory data
        ) = SplTokenLib.close_account(
            splTokenProgram,
            wsolAta,
            userPda,        // destination — receives all lamports
            activatorPda,   // owner — signed by precompile via regular call
            noSigners
        );

        bytes32[] memory salts = new bytes32[](0);
        // Regular call (not delegatecall) — the CPI precompile signs as
        // external_auth(msg.sender = activator), matching wSOL ATA owner.
        try CpiProgram.invoke_signed(progId, metas, data, salts) {
            // success
        } catch (bytes memory err) {
            revert CpiCloseFailed(err);
        }

        // We don't have a clean way to recover wsolReceived from the
        // Meteora pool swap (no return value). Emit msg.value paid as
        // a proxy — rent payer / refund logic uses on-chain lamports
        // post-activation as the source of truth.
        emit Activated(user, msg.value, 0);
    }

    /// @notice View helper — returns true if the caller's unified PDA
    ///         already has lamports (i.e., is activated). Source-of-
    ///         truth probe; matches the Activate-button visibility gate
    ///         in rome-ui.
    function isActivated(address user) external view returns (bool) {
        bytes32 userPda = RomeEVMAccount.pda(user);
        return CpiProgram.account_lamports(userPda) > 0;
    }
}
