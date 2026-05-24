// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Mirror of the defensive-guard arithmetic used in `SPL_ERC20.allowance`
/// and `SPL_ERC20.totalSupply` post-FB-2. Pure functions so the predicate
/// + early-exit + sentinel-readback logic is testable on hardhat-network
/// without the SPL CPI roundtrip.
///
/// The three pre-FB-2 bugs (verified Hadrian 2026-05-15):
///   FB-2a: `allowance` reverted "User does not exist" when the spender
///          had never been registered in the wrapper's ERC20Users mapping
///          (because allowance called `_users.get_user(spender)`).
///   FB-2b: `allowance` reverted with "account_data_at: range 72..108
///          out of 0 bytes" when the owner had no ATA for this mint
///          (because it read 36 bytes from offset 72 of an empty buffer).
///   FB-2c: `totalSupply` reverted similarly when the SPL mint account
///          was uninitialized.
///
/// The fix substitutes `HelperProgram.pda(spender)` for the get_user
/// lookup (FB-2a — same derivation, never reverts) AND gates the
/// readBytesAt / readU64At calls behind `account_lamports(account) > 0`
/// existence probes (FB-2b + FB-2c — matches the balanceOf pattern shipped
/// post-0acabea). All three view methods then return 0 instead of
/// reverting, which is what ERC-20 consumers (DEX routers, wagmi
/// multicall, wallet UIs) expect.
contract ViewDefensiveHelper {
    /// @notice Pure mirror of SPL_ERC20.allowance's post-FB-2 control flow.
    ///
    /// FB-2 scope is the missing-state guards only — does NOT include
    /// FB-1's u64::MAX → MaxUint256 sentinel (that lives in PR #160 and
    /// will merge into allowance() separately; either order is fine).
    ///
    /// Inputs are the OBSERVED state the real wrapper would see from
    /// the SPL CPI roundtrips:
    /// @param ataLamports     `AccountReader.lamportsOf(ownerAta)` — 0 ⇔ ATA missing.
    /// @param delegateIsSome  `COption<Pubkey>` tag at offset 72..76 of the ATA.
    /// @param storedDelegate  `Pubkey` at offset 76..108 of the ATA (only meaningful when `delegateIsSome`).
    /// @param spenderPda      `HelperProgram.pda(spender)` — never reverts, matches `external_auth(spender)`.
    /// @param delegatedAmount `u64 LE` at offset 121 of the ATA (only meaningful when `delegateIsSome`).
    ///
    /// Branches:
    ///  - FB-2b: `ataLamports == 0` → return 0 (owner has no ATA, no allowance possible).
    ///  - mismatched delegate → return 0.
    ///  - otherwise → return `uint256(delegatedAmount)`.
    function tryReadAllowance(
        uint64 ataLamports,
        bool delegateIsSome,
        bytes32 storedDelegate,
        bytes32 spenderPda,
        uint64 delegatedAmount
    ) external pure returns (uint256) {
        // FB-2b: missing-ATA early exit. Must fire BEFORE any readBytesAt
        // (real contract) since the SPL precompile reverts on a zero-byte
        // buffer.
        if (ataLamports == 0) {
            return 0;
        }

        // FB-2a: `HelperProgram.pda(spender)` is precomputed by the
        // caller; the real wrapper substitutes that for the
        // `_users.get_user(spender)` lookup that used to revert when
        // the spender had no ERC20Users mapping entry.
        bytes32 delegate = delegateIsSome ? storedDelegate : bytes32(0);
        if (delegate != spenderPda) {
            return 0;
        }

        return uint256(delegatedAmount);
    }

    /// @notice Pure mirror of SPL_ERC20.totalSupply's post-FB-2 control flow.
    ///
    /// @param mintLamports    `AccountReader.lamportsOf(mintId)` — 0 ⇔ mint missing.
    /// @param onChainSupply   `u64 LE` at offset 36 of the mint account (only meaningful when `mintLamports > 0`).
    function tryReadTotalSupply(uint64 mintLamports, uint64 onChainSupply)
        external
        pure
        returns (uint256)
    {
        if (mintLamports == 0) {
            return 0;
        }
        return uint256(onChainSupply);
    }

    /// @notice Pure mirror of SPL_ERC20_cached.balanceOf's defensive guard.
    /// Returns 0 when ATA missing; otherwise the on-chain balance.
    function tryReadBalanceOf(uint64 ataLamports, uint64 onChainBalance)
        external
        pure
        returns (uint256)
    {
        if (ataLamports == 0) {
            return 0;
        }
        return uint256(onChainBalance);
    }

    /// @notice Predicate for whether approve() must auto-create the owner ATA
    /// before SPL approve_checked. True iff the ATA has no lamports.
    function ownerNeedsAta(uint64 ownerAtaLamports) external pure returns (bool) {
        return ownerAtaLamports == 0;
    }
}
