// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title FacadePrecompileMock
/// @notice Stand-in for WithdrawCached (0xff..0b), SplCached (0xff..05),
///         AssociatedSplCached (0xff..06), HelperProgram (0xff..09) and
///         SystemProgram (0xff..07) — installed via `hardhat_setCode` at each
///         real precompile address, same pattern as
///         `contracts/bridge/test/BridgePrecompileMock.sol`. Each install gets
///         its own storage, so this only records what WrappedGasFacade calls
///         and who it signs as; it does not model a real cross-address SPL
///         balance (that check is enforced by Solana's SPL Token program, not
///         by Rome's precompile, and can't be given behavioral fidelity from
///         Solidity).
contract FacadePrecompileMock {
    bytes32 public constant GAS_MINT = keccak256("facade-mock-gas-mint");

    function ata(address user, bytes32 mint) external pure returns (bytes32) {
        require(mint == GAS_MINT, "mock: non-gas mint");
        return keccak256(abi.encodePacked("facade-mock-ata", user));
    }

    function mint_id() external pure returns (bytes32) {
        return GAS_MINT;
    }

    // ── WithdrawCached (0xff..0b) ────────────────────────────────────────
    address public lastWithdrawToAtaCaller;
    uint256 public lastWithdrawToAtaWei;
    uint256 public withdrawToAtaCount;

    function withdraw_to_ata(uint256 wei_) external {
        lastWithdrawToAtaCaller = msg.sender;
        lastWithdrawToAtaWei = wei_;
        withdrawToAtaCount += 1;
    }

    address public lastDepositCaller;
    uint256 public lastDepositWei;
    uint256 public depositCount;

    /// Mints `wei_` native to the caller, mirroring the real precompile's
    /// `Diff::TransferTo(context.caller)`. The mock account must be pre-funded
    /// (`hardhat_setBalance`) for the payout to succeed.
    function deposit(uint256 wei_) external {
        lastDepositCaller = msg.sender;
        lastDepositWei = wei_;
        depositCount += 1;
        (bool sent, ) = payable(msg.sender).call{value: wei_}("");
        require(sent, "mock: native mint failed");
    }

    // ── SplCached (0xff..05) ─────────────────────────────────────────────
    address public lastTransferCaller;
    address public lastTransferTo;
    uint256 public lastTransferAmount;
    uint256 public transferCount;

    /// transfer(address,uint256) — 0xa9059cbb, current-rollup-mint variant.
    function transfer(address to, uint256 amount) external {
        lastTransferCaller = msg.sender;
        lastTransferTo = to;
        lastTransferAmount = amount;
        transferCount += 1;
    }

    // ── AssociatedSplCached (0xff..06) ───────────────────────────────────
    uint256 public createAtaCount;

    function create_ata() external {
        createAtaCount += 1;
    }

    // ── HelperProgram (0xff..09) delegate transfer ───────────────────────
    mapping(bytes32 => bool) private _authorized; // keccak(from_ata,caller) => allowed

    address public lastTransferSplCaller;
    bytes32 public lastTransferSplFromAta;
    bytes32 public lastTransferSplToAta;
    uint64 public lastTransferSplTokens;
    bytes32 public lastTransferSplMint;
    uint256 public transferSplCount;

    /// Test-only setter: authorize `caller` to move `from_ata` — mirrors "is
    /// owner or delegate of from_ata" without reimplementing SPL Token.
    function setAuthorized(bytes32 from_ata, address caller, bool ok) external {
        _authorized[keccak256(abi.encodePacked(from_ata, caller))] = ok;
    }

    /// transfer_spl(bytes32,bytes32,uint64,bytes32) — 0x766b362a.
    function transfer_spl(bytes32 from_ata, bytes32 to_ata, uint64 tokens, bytes32 mint) external {
        require(mint == GAS_MINT, "mock: non-gas mint");
        require(
            _authorized[keccak256(abi.encodePacked(from_ata, msg.sender))],
            "mock: caller neither owner nor delegate of from_ata"
        );
        lastTransferSplCaller = msg.sender;
        lastTransferSplFromAta = from_ata;
        lastTransferSplToAta = to_ata;
        lastTransferSplTokens = tokens;
        lastTransferSplMint = mint;
        transferSplCount += 1;
    }

    /// Test-only: clears the call counters between tests that share this
    /// mock's storage (one install per suite, not per test — `hardhat_setCode`
    /// replaces code, not storage).
    function reset() external {
        withdrawToAtaCount = 0;
        depositCount = 0;
        transferCount = 0;
        createAtaCount = 0;
        transferSplCount = 0;
    }

    receive() external payable {}
}
