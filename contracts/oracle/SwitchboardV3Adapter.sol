// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IExtendedOracleAdapter.sol";
import "./IAdapterFactory.sol";
import "./IAdapterMetadata.sol";
import "./SwitchboardParser.sol";
import "../interface.sol";

/// @title SwitchboardV3Adapter
/// @notice Per-feed adapter that reads AggregatorAccountData from Switchboard V3
///         via Rome's CPI precompile. Same interface as PythPullAdapter.
///         Deployed as EIP-1167 clone by OracleAdapterFactory.
contract SwitchboardV3Adapter is IExtendedOracleAdapter, IAdapterMetadata {
    bytes32 public switchboardAccount;
    string private _description;
    uint256 public maxStaleness;
    address public factory;
    bool public initialized;
    uint64 public createdAt;

    error StalePriceFeed();
    error AdapterPaused();
    error HistoricalRoundsNotSupported();
    error NonPositivePrice();
    error AlreadyInitialized();
    error OnlyFactory();
    error EMANotSupported();

    /// @notice Initialize the adapter (called once by factory after clone deployment)
    function initialize(
        bytes32 _switchboardAccount,
        string calldata desc,
        uint256 _maxStaleness,
        address _factory
    ) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;

        switchboardAccount = _switchboardAccount;
        _description = desc;
        maxStaleness = _maxStaleness;
        factory = _factory;
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
    function priceStatus() external view returns (uint8) {
        if (IAdapterFactory(factory).isPaused(address(this))) return 2;

        SwitchboardParser.SwitchboardPrice memory parsed = _readAndParse();
        if (block.timestamp - uint256(uint64(parsed.timestamp)) > maxStaleness) return 1;
        return 0;
    }

    /// @notice Oracle source type: 1 = SwitchboardV3
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

    function _readAndParse() internal view returns (SwitchboardParser.SwitchboardPrice memory) {
        (,,,,, bytes memory data) = CpiProgram.account_info(switchboardAccount);
        return SwitchboardParser.parse(data);
    }

    function _checkStaleness(int64 timestamp) internal view {
        if (block.timestamp - uint256(uint64(timestamp)) > maxStaleness) revert StalePriceFeed();
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
