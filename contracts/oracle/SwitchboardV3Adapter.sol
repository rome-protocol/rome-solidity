// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IExtendedOracleAdapter.sol";
import "./IAdapterFactory.sol";
import "./IAdapterMetadata.sol";
import "./SwitchboardParser.sol";
import "../interface.sol";

/// @title SwitchboardV3Adapter
/// @notice Per-feed adapter that reads AggregatorAccountData from Switchboard V2
///         (program SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f) via Rome's CPI
///         precompile. Same interface as PythPullAdapter. Deployed as EIP-1167
///         clone by OracleAdapterFactory.
/// @dev The contract name keeps "V3" for backwards compatibility with the
///      deploy scripts and cached ABIs, but both the program ID passed by
///      the factory and the byte layout consumed by SwitchboardParser target
///      the Switchboard V2 legacy aggregator. See SwitchboardParser.sol for
///      the underlying layout; see the M-6 fix commit for the naming-fix
///      rationale.
contract SwitchboardV3Adapter is IExtendedOracleAdapter, IAdapterMetadata {
    bytes32 public switchboardAccount;
    string private _description;
    uint256 public maxStaleness;
    address public factory;
    bool public initialized;
    uint64 public createdAt;
    /// @notice Solana program that must own `switchboardAccount` on every
    ///         read. See PythPullAdapter for the rationale; the same storage
    ///         pattern applies (clones preclude `immutable`).
    bytes32 public expectedProgramId;

    error StalePriceFeed();
    error AdapterPaused();
    error HistoricalRoundsNotSupported();
    error NonPositivePrice();
    error AlreadyInitialized();
    error OnlyFactory();
    error EMANotSupported();
    error StalenessOutOfRange(uint256 staleness);
    error AccountOwnerChanged();

    /// @notice Lock the implementation contract from direct initialization.
    ///         Clones deployed via `Clones.clone` have independent storage and
    ///         are unaffected; this prevents an attacker from calling
    ///         `initialize()` directly on the implementation that
    ///         `OracleAdapterFactory.switchboardImplementation` points to.
    constructor() {
        initialized = true;
    }

    /// @notice Initialize the adapter (called once by factory after clone deployment)
    /// @param _expectedProgramId Solana program that must own `_switchboardAccount`
    ///        on every read (validated at each `_readAndParse` to detect
    ///        account ownership reassignment via `assign` — M-5).
    function initialize(
        bytes32 _switchboardAccount,
        string calldata desc,
        uint256 _maxStaleness,
        address _factory,
        bytes32 _expectedProgramId
    ) external {
        if (initialized) revert AlreadyInitialized();
        if (_maxStaleness < 1 || _maxStaleness > 24 hours) revert StalenessOutOfRange(_maxStaleness);
        initialized = true;

        switchboardAccount = _switchboardAccount;
        _description = desc;
        maxStaleness = _maxStaleness;
        factory = _factory;
        expectedProgramId = _expectedProgramId;
        createdAt = uint64(block.timestamp);
    }

    /// @notice Always 8 — prices are normalized to 10^-8
    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external view returns (string memory) {
        return _description;
    }

    function version() external pure returns (uint256) {
        return 2;
    }

    /// @notice Returns the latest Switchboard price normalized to 8 decimals
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        _checkPaused();

        SwitchboardParser.SwitchboardPrice memory parsed = _readAndParse();

        _checkStaleness(parsed.timestamp);

        answer = _normalize(parsed.mantissa, parsed.scale);
        if (answer <= 0) revert NonPositivePrice();

        roundId = 1;
        startedAt = uint256(uint64(parsed.timestamp));
        updatedAt = uint256(uint64(parsed.timestamp));
        answeredInRound = 1;
    }

    /// @notice Historical rounds are not supported
    function getRoundData(uint80) external pure returns (
        uint80, int256, uint256, uint256, uint80
    ) {
        revert HistoricalRoundsNotSupported();
    }

    /// @notice Full price data — returns mantissa/scale as raw price fields
    function latestPriceData() external view returns (
        int64 price, uint64 conf, int32 expo, uint64 publishTime
    ) {
        _checkPaused();
        SwitchboardParser.SwitchboardPrice memory parsed = _readAndParse();
        _checkStaleness(parsed.timestamp);

        // Map Switchboard fields to the extended interface:
        // price = normalized 8-decimal answer truncated to int64
        int256 normalized = _normalize(parsed.mantissa, parsed.scale);
        price = int64(normalized);
        conf = 0; // Switchboard doesn't provide confidence intervals
        expo = -8; // Already normalized to 8 decimals
        publishTime = uint64(parsed.timestamp);
    }

    /// @notice EMA is not supported by Switchboard
    function latestEMAData() external pure returns (
        int64, uint64, int32, uint64
    ) {
        revert EMANotSupported();
    }

    /// @notice Derived price status: 0 = Trading, 1 = Stale, 2 = Paused
    /// @dev Clock skew (timestamp > block.timestamp) is treated as stale, not
    ///      a panic — see _checkStaleness for the underflow guard rationale.
    function priceStatus() external view returns (uint8) {
        if (IAdapterFactory(factory).isPaused(address(this))) return 2;

        SwitchboardParser.SwitchboardPrice memory parsed = _readAndParse();
        uint256 ts = uint256(uint64(parsed.timestamp));
        if (ts > block.timestamp || block.timestamp - ts > maxStaleness) return 1;
        return 0;
    }

    /// @notice Oracle source type: 1 = Switchboard V2 (see contract-level
    ///         NatSpec for the name-retention rationale)
    function oracleType() external pure returns (uint8) {
        return 1;
    }

    /// @inheritdoc IAdapterMetadata
    function metadata() external view override returns (AdapterMetadata memory) {
        return AdapterMetadata({
            description: _description,
            sourceType: OracleSource.Switchboard,
            solanaAccount: switchboardAccount,
            maxStaleness: maxStaleness,
            createdAt: createdAt,
            factory: factory,
            paused: IAdapterFactory(factory).isPaused(address(this))
        });
    }

    // --- Internal helpers ---

    /// @dev Fetches the current owner and data for `switchboardAccount`.
    ///      Split out as `virtual` so test harnesses can override the CPI
    ///      precompile call (unavailable on hardhat's simulated network).
    function _fetchAccount() internal view virtual returns (bytes32 owner, bytes memory data) {
        (, owner,,,, data) = CpiProgram.account_info(switchboardAccount);
    }

    function _readAndParse() internal view returns (SwitchboardParser.SwitchboardPrice memory) {
        (bytes32 owner, bytes memory data) = _fetchAccount();
        // M-5: revalidate owner on every read — see PythPullAdapter rationale.
        if (owner != expectedProgramId) revert AccountOwnerChanged();
        return SwitchboardParser.parse(data);
    }

    /// @dev Guards against two failure modes:
    ///      1. `timestamp > block.timestamp` — Solana clock runs a few seconds
    ///         ahead of EVM on devnet. Without the explicit check, the subtraction
    ///         would panic with 0x11 (arithmetic underflow), which is swallowed
    ///         by BatchReader's `catch{}` and indistinguishable from other errors.
    ///      2. `block.timestamp - timestamp > maxStaleness` — data too old.
    function _checkStaleness(int64 timestamp) internal view {
        uint256 ts = uint256(uint64(timestamp));
        if (ts > block.timestamp || block.timestamp - ts > maxStaleness) {
            revert StalePriceFeed();
        }
    }

    function _checkPaused() internal view {
        if (IAdapterFactory(factory).isPaused(address(this))) revert AdapterPaused();
    }

    /// @dev Normalize Switchboard mantissa/scale to 8-decimal Chainlink format.
    ///      answer = (mantissa * 10^8) / 10^scale
    function _normalize(int128 mantissa, uint32 scale) internal pure returns (int256) {
        int256 result = int256(mantissa);
        if (scale <= 8) {
            result = result * int256(10 ** (8 - scale));
        } else {
            result = result / int256(10 ** (scale - 8));
        }
        return result;
    }
}
