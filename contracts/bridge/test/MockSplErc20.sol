// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockSplErc20
/// @notice Minimal mock that satisfies the subset of the SPL_ERC20 interface
///         consumed by RomeBridgeWithdraw: balanceOf, mint_id, getAta.
///         Does NOT inherit from SPL_ERC20 to avoid the CPI precompile call in
///         SPL_ERC20's constructor (which is unavailable on hardhatMainnet).
///         Test code casts the deployed address to the SPL_ERC20 type.
contract MockSplErc20 {
    bytes32 private _mintId;
    mapping(address => uint256) private _balances;
    mapping(address => bytes32) private _atas;

    constructor(bytes32 mintId_) {
        _mintId = mintId_;
    }

    function mint_id() external view returns (bytes32) {
        return _mintId;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function getAta(address user) external view returns (bytes32) {
        return _atas[user];
    }

    // ── Test helpers ──────────────────────────────────────────────────────────

    function setBalance(address account, uint256 amount) external {
        _balances[account] = amount;
    }

    function setAta(address user, bytes32 ata) external {
        _atas[user] = ata;
    }
}
