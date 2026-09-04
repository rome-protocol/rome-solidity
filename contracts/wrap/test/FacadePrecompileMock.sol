// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ITxTrack {
    function markCpi() external;
    function markCached() external;
}

/// @title TxTrackMock
/// @notice Shared one-track state a `FacadePrecompileMock` install cannot
///         hold itself — `hardhat_setCode` gives each installed address its
///         own storage, but the real one-track rule is a single flag for the
///         whole transaction (`handler_non_evm.rs`'s `found_cpi`). Deploy
///         once, point every install at it via `setTxTrack`.
contract TxTrackMock {
    error OneTrackViolation();
    bool public foundCpi;
    bool public foundCached;

    /// Mirrors `verify_call`: a legacy CPI dispatch after a cached dispatch
    /// already ran in this transaction is refused.
    function markCpi() external {
        if (foundCached) revert OneTrackViolation();
        foundCpi = true;
    }

    /// Mirrors `verify_call`: a cached-track dispatch after a legacy CPI
    /// already ran in this transaction is refused.
    function markCached() external {
        if (foundCpi) revert OneTrackViolation();
        foundCached = true;
    }

    function reset() external {
        foundCpi = false;
        foundCached = false;
    }
}

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
///         Solidity). `txTrack` (set via `setTxTrack`) reproduces the
///         one-track rule across installs — see `TxTrackMock` above.
contract FacadePrecompileMock {
    bytes32 public constant GAS_MINT = keccak256("facade-mock-gas-mint");

    address public txTrack;

    function setTxTrack(address t) external {
        txTrack = t;
    }

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
        if (txTrack != address(0)) ITxTrack(txTrack).markCached();
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
        if (txTrack != address(0)) ITxTrack(txTrack).markCached();
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
        if (txTrack != address(0)) ITxTrack(txTrack).markCached();
        lastTransferCaller = msg.sender;
        lastTransferTo = to;
        lastTransferAmount = amount;
        transferCount += 1;
    }

    mapping(bytes32 => bool) private _authorizedAddr; // keccak(from,caller) => allowed

    address public lastTransferFromCaller;
    address public lastTransferFromFrom;
    address public lastTransferFromTo;
    uint256 public lastTransferFromAmount;
    bytes32 public lastTransferFromMint;
    uint256 public transferFromCount;

    /// Test-only setter, address-keyed twin of `setAuthorized` for `transferFrom`.
    function setAuthorizedFrom(address from, address caller, bool ok) external {
        _authorizedAddr[keccak256(abi.encodePacked(from, caller))] = ok;
    }

    /// transferFrom(address,address,uint256,bytes32) — 0x401e3367, delegate
    /// variant: authority = external_auth(caller), accepted as the from-ATA's
    /// owner OR a sufficient-amount delegate.
    function transferFrom(address from, address to, uint256 amount, bytes32 mint) external {
        if (txTrack != address(0)) ITxTrack(txTrack).markCached();
        require(mint == GAS_MINT, "mock: non-gas mint");
        require(
            _authorizedAddr[keccak256(abi.encodePacked(from, msg.sender))],
            "mock: caller neither owner nor delegate of from"
        );
        lastTransferFromCaller = msg.sender;
        lastTransferFromFrom = from;
        lastTransferFromTo = to;
        lastTransferFromAmount = amount;
        lastTransferFromMint = mint;
        transferFromCount += 1;
    }

    // ── AssociatedSplCached (0xff..06) ───────────────────────────────────
    uint256 public createAtaCount;

    function create_ata() external {
        if (txTrack != address(0)) ITxTrack(txTrack).markCached();
        createAtaCount += 1;
    }

    address public lastCreateAtaForUser;
    bytes32 public lastCreateAtaForMint;
    uint256 public createAtaForCount;

    /// create_ata(address,bytes32) — 0x3de2251a, idempotent (no-op if the ATA
    /// already exists on the real precompile; this mock just counts calls).
    function create_ata(address user, bytes32 mint) external {
        if (txTrack != address(0)) ITxTrack(txTrack).markCached();
        lastCreateAtaForUser = user;
        lastCreateAtaForMint = mint;
        createAtaForCount += 1;
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
        if (txTrack != address(0)) ITxTrack(txTrack).markCpi();
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
        transferFromCount = 0;
        createAtaCount = 0;
        createAtaForCount = 0;
        transferSplCount = 0;
    }

    receive() external payable {}
}
