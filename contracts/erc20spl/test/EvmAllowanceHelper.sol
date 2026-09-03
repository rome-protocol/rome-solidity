// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Mirror of SPL_ERC20's post-#511 allowance surface: approve/allowance/
/// transferFrom-decrement are now plain EVM state, no SPL CPI at all (the
/// on-chain delegate grant moved to a one-time user->0xff..09 approve_spl
/// call, entirely decoupled from this mapping). Deployable and fully
/// exercisable on hardhat-network — unlike the rest of SPL_ERC20, none of
/// this touches a precompile.
///
/// No u64 saturation sentinel here (contrast the pre-#511
/// ApproveSaturationHelper): this mapping is uint256 EVM storage, not u64
/// SPL delegated_amount storage, so there is nothing to saturate against
/// and no sentinel value to reconstruct on readback.
contract EvmAllowanceHelper {
    error ERC20InvalidSpender(address spender);
    error ERC20InsufficientAllowance(address spender, uint256 currentAllowance, uint256 requiredAllowance);

    mapping(address => mapping(address => uint256)) private _allowances;
    mapping(address => uint256) private _balances;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    function setBalance(address account, uint256 amount) external {
        _balances[account] = amount;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) revert ERC20InvalidSpender(address(0));
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    /// Mirror of transferFrom's allowance check/decrement (moving tokens
    /// itself is out of scope here — that's the escrow/CPI path, covered
    /// by EscrowLedgerHelper). Infinite approval (type(uint256).max) is
    /// never decremented.
    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        address spender = msg.sender;
        uint256 currentAllowance = _allowances[from][spender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < value) {
                revert ERC20InsufficientAllowance(spender, currentAllowance, value);
            }
            unchecked {
                _allowances[from][spender] = currentAllowance - value;
            }
        }
        uint256 bal = _balances[from];
        require(bal >= value, "balance");
        _balances[from] = bal - value;
        _balances[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
