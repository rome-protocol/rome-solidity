// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockSplErc20
/// @notice Minimal mock that satisfies the subset of the SPL_ERC20 interface
///         consumed by RomeBridgeWithdraw + RomeBridgeInbound: balanceOf,
///         mint_id, getAta, allowance, decimals, transferFrom.
///         Does NOT inherit from SPL_ERC20 to avoid the CPI precompile call in
///         SPL_ERC20's constructor (which is unavailable on hardhatMainnet).
///         Test code casts the deployed address to the SPL_ERC20 type.
contract MockSplErc20 {
    bytes32 private _mintId;
    uint8 private _decimals;
    mapping(address => uint256) private _balances;
    mapping(address => bytes32) private _atas;
    mapping(address => mapping(address => uint256)) private _allowances;

    constructor(bytes32 mintId_) {
        _mintId = mintId_;
        _decimals = 6; // matches USDC — default test assumption
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

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    /// @notice Minimal ERC20 transferFrom for tests — no CPI, just shuffles
    ///         internal balance state. Returns bool per IERC20 spec.
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        require(allowed >= value, "allowance");
        uint256 bal = _balances[from];
        require(bal >= value, "balance");
        _allowances[from][msg.sender] = allowed - value;
        _balances[from] = bal - value;
        _balances[to] += value;
        return true;
    }

    // ── Test helpers ──────────────────────────────────────────────────────────

    function setBalance(address account, uint256 amount) external {
        _balances[account] = amount;
    }

    function setAta(address user, bytes32 ata) external {
        _atas[user] = ata;
    }

    function setDecimals(uint8 d) external {
        _decimals = d;
    }

    function setAllowance(address owner, address spender, uint256 value) external {
        _allowances[owner][spender] = value;
    }
}
