// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Mirror of SPL_ERC20's contract-holder escrow: a deployed contract can
/// never call `approve`, so its SPL lives in the wrapper's own ATA and its
/// balance is tracked here in EVM storage instead. The actual SPL CPI +
/// `code.length` check need a live chain to exercise for real; this pins
/// the pure routing + ledger arithmetic.
contract EscrowLedgerHelper {
    mapping(address => uint256) private _escrow;

    /// Sentinel returned by SPL_ERC20's real `_transfer` in place of `to`
    /// when the recipient is a contract: the SPL lands in the wrapper's
    /// own ATA (owned by `external_auth(address(this))`) instead of a
    /// contract that can never approve it back out.
    address public constant WRAPPER_ATA_OWNER_SENTINEL = address(0);

    /// Mirror of `_transfer`'s destination-address selection:
    /// `toIsContract ? address(this) : to`. Here "address(this)" is
    /// represented by the sentinel since a pure/view helper has no
    /// meaningful `address(this)` identity to assert against — the
    /// production-file mutation test (direct-call-escrow-shape) asserts
    /// the real ternary text directly; this helper locks the *logic*.
    function destinationAta(bool toIsContract, address to) external pure returns (address) {
        return toIsContract ? WRAPPER_ATA_OWNER_SENTINEL : to;
    }

    /// EOA-held SPL can only ever move because the wrapper is the EOA's
    /// SPL delegate (one-time user-signed `approve_spl` to 0xff..09). A
    /// contract holder's SPL already sits in the wrapper's own ATA, so
    /// paying it out needs no delegate — the wrapper is the owner.
    function requiresDelegate(bool fromIsContract) external pure returns (bool) {
        return !fromIsContract;
    }

    /// contract -> contract is a pure EVM ledger move: the SPL never
    /// leaves the wrapper's own ATA, so no CPI and no transfer-fee
    /// consideration applies.
    function isPureLedgerMove(bool fromIsContract, bool toIsContract) external pure returns (bool) {
        return fromIsContract && toIsContract;
    }

    function creditEscrow(address to, uint256 delivered) external {
        _escrow[to] += delivered;
    }

    function debitEscrow(address from, uint256 value) external {
        require(_escrow[from] >= value, "insufficient escrow balance");
        _escrow[from] -= value;
    }

    /// Mirror of balanceOf's dispatch: ledger for a contract holder,
    /// on-chain SPL balance (passed in — the real read needs a live
    /// chain) for an EOA.
    function balanceOf(bool isContract, address account, uint256 onChainBalance) external view returns (uint256) {
        return isContract ? _escrow[account] : onChainBalance;
    }

    function escrowOf(address account) external view returns (uint256) {
        return _escrow[account];
    }
}
