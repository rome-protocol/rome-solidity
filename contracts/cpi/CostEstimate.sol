// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CostEstimate — uniform quote shape for every Cardo adapter.
/// @dev Per cardo-foundation.md §4.1. The struct itself lives at top level so
///      it can be imported by both `ICostView` and each adapter.
///
///      USD precision: `uint256 usd8` throughout = 1e8 scale (Chainlink /
///      Oracle Gateway V2 convention). See §4.4 for rationale.
///
///      `oracleReads` is the audit trail of Oracle Gateway V2 adapter
///      addresses consulted to compute the quote. Every oracle-reading
///      helper in `CostEstimator` appends its adapter address before
///      returning. Adapters never write this field directly. Downstream
///      consumers (Cardo UI, MCP tools) re-check `getFeedHealth` against
///      each address to surface staleness before the user signs.

/// Solana rent requirement for a single account the capability touches.
struct RentRequirement {
    bytes32 accountPurpose;      // keccak("ATA:USDC"), keccak("obligation:Kamino") …
    uint64  lamports;            // rent-exempt minimum for the account
    bool    alreadyExists;       // if true, lamports is informational only
}

/// Protocol fee — e.g. Meteora swap fee, Kamino borrow fee.
struct ProtocolFee {
    bytes32 protocol;            // keccak("meteora") / keccak("kamino:borrow") …
    uint256 amountIn;            // native input-token units
    uint256 feeBps;              // 30 = 0.30%
    uint256 feeAmount;           // amountIn * feeBps / 10_000, pre-computed
}

/// Expected output for output-producing capabilities (swap, withdraw, …).
/// For non-output ops (borrow / repay / deposit / cancel) leave all fields
/// zero. Adapters MUST populate when there IS an output (enforces the
/// "zero means none" convention described in §13).
struct ExpectedOutput {
    address tokenErc20Spl;       // zero for non-output capabilities
    uint256 expectedAmount;      // best-effort from pool / protocol state
    uint256 minAmount;           // after slippage bound
}

/// Full cost quote. The rollup is a single call: `CostEstimator.totalCostUsd`.
struct CostEstimate {
    uint256 evmGasEstimate;      // from rome-evm-client estimate_gas (caller-supplied)
    uint64  solanaCuEstimate;    // per-capability adapter constant
    RentRequirement[] rentRequired;
    ProtocolFee[] fees;
    ExpectedOutput output;
    uint256 totalUserCostUsd;    // 1e8 scale
    address[] oracleReads;       // audit trail (§4.4)
}
