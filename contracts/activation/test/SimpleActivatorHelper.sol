// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SimpleActivatorHelper
/// @notice Pure-Solidity mirror of the post-1tx SimpleActivator's arithmetic
///         and predicate logic. The real activator's CPIs (`HelperProgram.
///         create_pda`, `HelperProgram.create_ata`, `ERC20Users.ensure_user`)
///         require a live Rome-EVM chain to exercise — but the constants,
///         the funding-formula, the msg.value validation, and the
///         `isActivated` predicate are all pure arithmetic and can be
///         pinned here on hardhat-network.
///
/// ## What this mirror covers (FB-4)
///
///   - PDA-funding math: USER_PDA_FUNDING == rent + 2*ata_rent + reserve.
///   - msg.value gate: must equal activationCost exactly (strict equality;
///     no overpay refund — caller pre-reads activationCost() so this is a
///     no-surprise check, NOT a forgiving gate).
///   - isActivated predicate: TRUE iff user PDA lamports > 0 AND both
///     wrapper ATAs have lamports > 0. Three observed values (PDA / wUSDC
///     ATA / wSOL ATA) reduce to one bool via AND.
///   - topUp arithmetic: msg.value > 0 gate (any positive amount accepted;
///     no fixed cost).
///
/// ## What this mirror deliberately does NOT cover
///
///   - The CPIs themselves — those need a live chain.
///   - The `ensure_user` mapping side-effects — also chain-side state.
///   - Multi-call sequencing — `activate()` does 5 CPIs in one tx
///     (create_pda, 2× create_ata, 2× ensure_user) and any ordering bug
///     surfaces only against a live chain.
contract SimpleActivatorHelper {
    /// Rent-exempt floor for a System Program 0-byte account. Verified
    /// 2026-05-15: (128 + 0) * 3480 * 2 = 890_880 lamports.
    uint64 public constant PDA_RENT_LAMPORTS = 890_880;

    /// Rent-exempt floor for an SPL Token Account (165 bytes). Verified
    /// 2026-05-15: (128 + 165) * 3480 * 2 = 2_039_280 lamports.
    uint64 public constant ATA_RENT_LAMPORTS = 2_039_280;

    /// Reserve for ~5 fresh-recipient SPL transfers — each ATA-create on
    /// behalf of a new recipient costs ATA_RENT_LAMPORTS funded by the
    /// caller's PDA. 5 × ATA_RENT covers a comfortable run of bridge-out
    /// or transfer-to-fresh-EVM-address operations before the user has
    /// to topUpUserPda.
    uint64 public constant FRESH_TRANSFER_RESERVE = 10_000_000;

    /// Reserve for 1 outbound CCTP burn. CCTP's `deposit_for_burn`
    /// creates a ~1.6KB `MessageSent` event account whose rent_payer is
    /// the user's PDA. (128 + 1600) × 3480 × 2 ≈ 12M lamports per burn;
    /// 15M covers rent + tx fee + small margin for Solana rent-rate
    /// adjustments. Pre-fix (2026-05-18), freshly-activated users
    /// reverted on their first CCTP burn with System Program
    /// `ResultWithNegativeLamports` (`Custom(1)`) because USER_PDA_FUNDING
    /// didn't include this reserve. The rent is reclaimed when Circle
    /// attests (~30 min) so typical paced usage refills naturally;
    /// burst capacity beyond 1 burn requires a `topUpUserPda` call.
    uint64 public constant CCTP_BURN_RESERVE = 15_000_000;

    /// Mirror of SimpleActivator.USER_PDA_FUNDING:
    ///   PDA_RENT + 2 * ATA_RENT + FRESH_TRANSFER_RESERVE + CCTP_BURN_RESERVE.
    /// Pure function — no on-chain side-effect — so this is the value
    /// the real `activate()` will pass to `HelperProgram.create_pda(user,
    /// lamports)`. Treat any deviation between this and the real
    /// constant as a regression.
    function expectedUserPdaFunding() external pure returns (uint64) {
        return PDA_RENT_LAMPORTS +
            2 * ATA_RENT_LAMPORTS +
            FRESH_TRANSFER_RESERVE +
            CCTP_BURN_RESERVE;
    }

    /// Mirror of the msg.value gate the real `activate()` enforces. The
    /// post-FB-4 design uses strict equality (`msg.value == activationCost`)
    /// — no overpay refund. Caller is expected to pre-read
    /// `activationCost()` and pass exactly that.
    ///
    /// @return true iff the caller's msg.value matches activationCost exactly.
    function validatePayment(uint256 msgValue, uint256 activationCost)
        external
        pure
        returns (bool)
    {
        return msgValue == activationCost;
    }

    /// Mirror of `isActivated(user)` predicate. The real function reads
    /// three Solana account lamports values (user PDA, user's wUSDC ATA,
    /// user's wSOL ATA) and reduces to one bool — fully activated iff all
    /// three exist on Solana.
    ///
    /// This pure mirror skips the reads and just takes the observed
    /// lamports values as parameters, returning the same AND-of-three-
    /// non-zero predicate. Verifies the control flow on hardhat-network
    /// without the SPL CPI roundtrip.
    function isActivatedFromLamports(
        uint64 userPdaLamports,
        uint64 wusdcAtaLamports,
        uint64 wsolAtaLamports
    ) external pure returns (bool) {
        return userPdaLamports > 0 && wusdcAtaLamports > 0 && wsolAtaLamports > 0;
    }

    /// Mirror of `topUpUserPda` payment validation. The post-FB-4 design
    /// accepts any positive msg.value (variable refill size). The real
    /// function then routes msg.value via `swap_gas_to_lamports` to add
    /// SOL lamports to the caller's PDA — that side-effect happens on a
    /// live chain only.
    function validateTopUpPayment(uint256 msgValue) external pure returns (bool) {
        return msgValue > 0;
    }
}
