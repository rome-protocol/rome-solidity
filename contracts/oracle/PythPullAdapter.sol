// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IExtendedOracleAdapter.sol";
import "./IAdapterFactory.sol";
import "./IAdapterMetadata.sol";
import "./PythPullParser.sol";
import "../interface.sol";

/// @title PythPullAdapter
/// @notice Per-feed adapter that reads PriceUpdateV2 from Pyth Solana Receiver
///         via Rome's CPI precompile. Implements both IAggregatorV3Interface and
///         IExtendedOracleAdapter. Deployed as EIP-1167 clone by OracleAdapterFactory.
contract PythPullAdapter is IExtendedOracleAdapter, IAdapterMetadata {
    bytes32 public pythAccount;
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

    /// @notice Initialize the adapter (called once by factory after clone deployment)
    /// @param _pythAccount Pyth Pull receiver PDA pubkey
    /// @param desc Human-readable description (e.g., "SOL / USD")
    /// @param _maxStaleness Maximum acceptable age of price data in seconds
    /// @param _factory OracleAdapterFactory address
    function initialize(
        bytes32 _pythAccount,
        string calldata desc,
        uint256 _maxStaleness,
        address _factory
    ) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;

        pythAccount = _pythAccount;
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

    /// @notice Returns the latest Pyth price normalized to 8 decimals
    /// @dev Reads raw PriceUpdateV2 account via CPI precompile, parses with
    ///      PythPullParser, checks staleness and pause, normalizes to 8 decimals.
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        _checkPaused();

        PythPullParser.PythPullPrice memory parsed = _readAndParse();

        _checkStaleness(parsed.publishTime);

        if (parsed.price <= 0) revert NonPositivePrice();

        answer = _normalize(parsed.price, parsed.expo);
        roundId = 1;
        startedAt = uint256(parsed.publishTime);
        updatedAt = uint256(parsed.publishTime);
        answeredInRound = 1;
    }

    /// @notice Historical rounds are not supported
    function getRoundData(uint80) external pure returns (
        uint80, int256, uint256, uint256, uint80
    ) {
        revert HistoricalRoundsNotSupported();
    }

    /// @notice Full price data including confidence
    function latestPriceData() external view returns (
        int64 price, uint64 conf, int32 expo, uint64 publishTime
    ) {
        _checkPaused();
        PythPullParser.PythPullPrice memory parsed = _readAndParse();
        _checkStaleness(parsed.publishTime);
        return (parsed.price, parsed.conf, parsed.expo, parsed.publishTime);
    }

    /// @notice EMA price data
    function latestEMAData() external view returns (
        int64 emaPrice, uint64 emaConf, int32 expo, uint64 publishTime
    ) {
        _checkPaused();
        PythPullParser.PythPullPrice memory parsed = _readAndParse();
        _checkStaleness(parsed.publishTime);
        return (parsed.emaPrice, parsed.emaConf, parsed.expo, parsed.publishTime);
    }

    /// @notice Derived price status: 0 = Trading, 1 = Stale, 2 = Paused
    function priceStatus() external view returns (uint8) {
        if (IAdapterFactory(factory).isPaused(address(this))) return 2;

        PythPullParser.PythPullPrice memory parsed = _readAndParse();
        if (block.timestamp - parsed.publishTime > maxStaleness) return 1;
        return 0;
    }

    /// @notice Oracle source type: 0 = PythPull
    function oracleType() external pure returns (uint8) {
        return 0;
    }

    /// @inheritdoc IAdapterMetadata
    function metadata() external view override returns (AdapterMetadata memory) {
        return AdapterMetadata({
            description: _description,
            sourceType: OracleSource.Pyth,
            solanaAccount: pythAccount,
            maxStaleness: maxStaleness,
            createdAt: createdAt,
            factory: factory,
            paused: IAdapterFactory(factory).isPaused(address(this))
        });
    }

    // --- Internal helpers ---

    function _readAndParse() internal view returns (PythPullParser.PythPullPrice memory) {
        (,,,,, bytes memory data) = CpiProgram.account_info(pythAccount);
        return PythPullParser.parse(data);
    }

    function _checkStaleness(uint64 publishTime) internal view {
        if (block.timestamp - publishTime > maxStaleness) revert StalePriceFeed();
    }

    function _checkPaused() internal view {
        if (IAdapterFactory(factory).isPaused(address(this))) revert AdapterPaused();
    }

    /// @dev Normalize Pyth price to 8 decimals.
    ///      answer = price * 10^(expo - (-8))
    function _normalize(int64 price, int32 expo) internal pure returns (int256) {
        int256 scaledPrice = int256(price);
        int32 targetExpo = -8;
        int32 diff = expo - targetExpo;

        if (diff > 0) {
            scaledPrice = scaledPrice * int256(10 ** uint32(diff));
        } else if (diff < 0) {
            scaledPrice = scaledPrice / int256(10 ** uint32(-diff));
        }

        return scaledPrice;
    }
}
