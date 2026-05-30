// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./PythPullAdapter.sol";
import "./SwitchboardV3Adapter.sol";
import "./CachedPythAdapter.sol";
import "./CachedFeedAdapter.sol";
import "../interface.sol";

/// @title OracleAdapterFactory
/// @notice Unified factory deploying both Pyth Pull and Switchboard V2 adapters
///         (the latter is named `SwitchboardV3Adapter` for legacy reasons; see
///         SwitchboardV3Adapter.sol) via EIP-1167 minimal proxy clones.
///         Maintains a registry and provides pause/unpause emergency controls.
contract OracleAdapterFactory {
    // --- State ---
    address public owner;
    address public immutable pythImplementation;
    address public immutable switchboardImplementation;
    address public immutable cachedPythImplementation;
    address public immutable cachedFeedImplementation;
    bytes32 public immutable pythReceiverProgramId;
    bytes32 public immutable switchboardProgramId;
    uint256 public constant MIN_STALENESS = 1;
    uint256 public constant MAX_STALENESS = 24 hours;
    uint256 public defaultMaxStaleness;

    mapping(bytes32 => address) public pythAdapters;
    mapping(bytes32 => address) public switchboardAdapters;
    mapping(bytes32 => address) public cachedPythAdapters;
    /// @notice Generic cache adapters keyed by the wrapped underlying feed address.
    mapping(address => address) public cachedFeedAdapters;
    address[] public allAdapters;
    mapping(address => bool) public pausedAdapters;
    /// @notice Reverse lookup so pause/unpause ops can reject arbitrary
    ///         addresses. Populated in `createPythFeed` / `createSwitchboardFeed`.
    mapping(address => bool) public isRegisteredAdapter;

    // --- Events ---
    event PythFeedCreated(address indexed adapter, bytes32 indexed pythAccount, string description);
    event SwitchboardFeedCreated(address indexed adapter, bytes32 indexed sbAccount, string description);
    event CachedPythFeedCreated(address indexed adapter, bytes32 indexed pythAccount, string description);
    event CachedFeedCreated(address indexed adapter, address indexed underlying, string description);
    event AdapterPaused(address indexed adapter);
    event AdapterUnpaused(address indexed adapter);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event DefaultMaxStalenessUpdated(uint256 oldStaleness, uint256 newStaleness);

    // --- Errors ---
    error FeedAlreadyExists();
    error InvalidAccountOwner();
    error OnlyOwner();
    error StalenessOutOfRange(uint256 staleness);
    error ZeroAddress();
    error AdapterNotRegistered();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    /// @param _pythImpl Address of the PythPullAdapter logic contract
    /// @param _switchboardImpl Address of the SwitchboardV3Adapter logic contract
    ///                         (name retained for legacy; targets Switchboard V2)
    /// @param _pythReceiverProgramId Pyth Solana Receiver program ID (rec5EKM...)
    /// @param _switchboardProgramId Switchboard V2 program ID
    ///                              (SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f)
    /// @param _defaultMaxStaleness Default staleness threshold in seconds
    /// @param _cachedPythImpl Address of the CachedPythAdapter logic contract
    ///                        (cached-pyth track — same feed source as Pyth Pull,
    ///                        amortizes the Borsh parse via refresh())
    /// @param _cachedFeedImpl Address of the CachedFeedAdapter logic contract
    ///                        (generic cache — wraps any AggregatorV3 feed)
    constructor(
        address _pythImpl,
        address _switchboardImpl,
        bytes32 _pythReceiverProgramId,
        bytes32 _switchboardProgramId,
        uint256 _defaultMaxStaleness,
        address _cachedPythImpl,
        address _cachedFeedImpl
    ) {
        if (_defaultMaxStaleness < MIN_STALENESS || _defaultMaxStaleness > MAX_STALENESS)
            revert StalenessOutOfRange(_defaultMaxStaleness);
        owner = msg.sender;
        pythImplementation = _pythImpl;
        switchboardImplementation = _switchboardImpl;
        cachedPythImplementation = _cachedPythImpl;
        cachedFeedImplementation = _cachedFeedImpl;
        pythReceiverProgramId = _pythReceiverProgramId;
        switchboardProgramId = _switchboardProgramId;
        defaultMaxStaleness = _defaultMaxStaleness;
    }

    /// @notice Deploy a new Pyth Pull adapter (permissionless)
    /// @param pythAccountPubkey Pyth Pull receiver PDA for this feed
    /// @param desc Human-readable description (e.g., "SOL / USD")
    /// @param staleness Max staleness in seconds (0 = use defaultMaxStaleness)
    function createPythFeed(
        bytes32 pythAccountPubkey,
        string calldata desc,
        uint256 staleness
    ) external returns (address adapter) {
        if (pythAdapters[pythAccountPubkey] != address(0)) revert FeedAlreadyExists();

        // Validate: account must be owned by Pyth Receiver program
        (, bytes32 accountOwner,,,,) = CpiProgram.account_info(pythAccountPubkey);
        if (accountOwner != pythReceiverProgramId) revert InvalidAccountOwner();

        // Deploy minimal proxy clone
        adapter = Clones.clone(pythImplementation);

        // Initialize atomically (no front-running gap)
        uint256 maxStale = staleness > 0 ? staleness : defaultMaxStaleness;
        _requireStalenessInRange(maxStale);
        PythPullAdapter(adapter).initialize(
            pythAccountPubkey,
            desc,
            maxStale,
            address(this),
            pythReceiverProgramId
        );

        // Register
        pythAdapters[pythAccountPubkey] = adapter;
        allAdapters.push(adapter);
        isRegisteredAdapter[adapter] = true;

        emit PythFeedCreated(adapter, pythAccountPubkey, desc);
    }

    /// @notice Deploy a new cached Pyth Pull adapter (permissionless). Same feed
    ///         source + ownership validation as `createPythFeed`, but the adapter
    ///         amortizes the Borsh parse: a keeper calls `refresh()` to parse +
    ///         SSTORE the price once, and consumers read a cheap SLOAD via
    ///         `latestRoundData()`. A freshly-created clone must be refreshed once
    ///         before it serves a price (reverts `UninitializedPriceFeed` until then).
    /// @param pythAccountPubkey Pyth Pull receiver PDA for this feed
    /// @param desc Human-readable description (e.g., "SOL / USD")
    /// @param staleness Max staleness in seconds (0 = use defaultMaxStaleness)
    function createCachedPythFeed(
        bytes32 pythAccountPubkey,
        string calldata desc,
        uint256 staleness
    ) external returns (address adapter) {
        if (cachedPythAdapters[pythAccountPubkey] != address(0)) revert FeedAlreadyExists();

        // Validate: account must be owned by Pyth Receiver program (same as createPythFeed)
        (, bytes32 accountOwner,,,,) = CpiProgram.account_info(pythAccountPubkey);
        if (accountOwner != pythReceiverProgramId) revert InvalidAccountOwner();

        // Deploy minimal proxy clone
        adapter = Clones.clone(cachedPythImplementation);

        // Initialize atomically. CachedPythAdapter does no per-read owner
        // re-validation (the factory's one-time check above suffices), so its
        // initialize omits the expectedProgramId arg PythPullAdapter takes.
        uint256 maxStale = staleness > 0 ? staleness : defaultMaxStaleness;
        _requireStalenessInRange(maxStale);
        CachedPythAdapter(adapter).initialize(
            pythAccountPubkey,
            desc,
            maxStale,
            address(this)
        );

        // Register
        cachedPythAdapters[pythAccountPubkey] = adapter;
        allAdapters.push(adapter);
        isRegisteredAdapter[adapter] = true;

        emit CachedPythFeedCreated(adapter, pythAccountPubkey, desc);
    }

    /// @notice Deploy a generic cache over an existing AggregatorV3 feed
    ///         (permissionless). `underlying` is an already-deployed adapter
    ///         (a PythPullAdapter, SwitchboardV3Adapter, …); the returned clone
    ///         amortizes its read via refresh()/SLOAD. No Solana account check
    ///         here — the underlying adapter was validated when it was created.
    ///         A freshly-created clone must be refreshed once before it serves a
    ///         price (reverts `UninitializedPriceFeed` until then).
    /// @param underlying Address of the AggregatorV3 feed to wrap
    /// @param desc Human-readable description (e.g., "SOL / USD")
    /// @param staleness Max staleness in seconds (0 = use defaultMaxStaleness)
    function createCachedFeed(
        address underlying,
        string calldata desc,
        uint256 staleness
    ) external returns (address adapter) {
        if (underlying == address(0)) revert ZeroAddress();
        if (cachedFeedAdapters[underlying] != address(0)) revert FeedAlreadyExists();

        // Deploy minimal proxy clone
        adapter = Clones.clone(cachedFeedImplementation);

        // Initialize atomically
        uint256 maxStale = staleness > 0 ? staleness : defaultMaxStaleness;
        _requireStalenessInRange(maxStale);
        CachedFeedAdapter(adapter).initialize(
            underlying,
            desc,
            maxStale,
            address(this)
        );

        // Register
        cachedFeedAdapters[underlying] = adapter;
        allAdapters.push(adapter);
        isRegisteredAdapter[adapter] = true;

        emit CachedFeedCreated(adapter, underlying, desc);
    }

    /// @notice Deploy a new Switchboard V2 adapter (permissionless; contract
    ///         name retains "V3" for legacy reasons — see
    ///         SwitchboardV3Adapter.sol for details)
    /// @param sbAccountPubkey Switchboard aggregator account pubkey
    /// @param desc Human-readable description
    /// @param staleness Max staleness in seconds (0 = use defaultMaxStaleness)
    function createSwitchboardFeed(
        bytes32 sbAccountPubkey,
        string calldata desc,
        uint256 staleness
    ) external returns (address adapter) {
        if (switchboardAdapters[sbAccountPubkey] != address(0)) revert FeedAlreadyExists();

        // Validate: account must be owned by Switchboard program
        (, bytes32 accountOwner,,,,) = CpiProgram.account_info(sbAccountPubkey);
        if (accountOwner != switchboardProgramId) revert InvalidAccountOwner();

        // Deploy minimal proxy clone
        adapter = Clones.clone(switchboardImplementation);

        // Initialize atomically
        uint256 maxStale = staleness > 0 ? staleness : defaultMaxStaleness;
        _requireStalenessInRange(maxStale);
        SwitchboardV3Adapter(adapter).initialize(
            sbAccountPubkey,
            desc,
            maxStale,
            address(this),
            switchboardProgramId
        );

        // Register
        switchboardAdapters[sbAccountPubkey] = adapter;
        allAdapters.push(adapter);
        isRegisteredAdapter[adapter] = true;

        emit SwitchboardFeedCreated(adapter, sbAccountPubkey, desc);
    }

    /// @notice Check if an adapter is paused
    function isPaused(address adapter) external view returns (bool) {
        return pausedAdapters[adapter];
    }

    /// @notice Pause an adapter (owner only)
    /// @dev Only adapters registered via `createPythFeed` /
    ///      `createSwitchboardFeed` are permitted targets — prevents typos
    ///      from toggling paused-state on arbitrary addresses.
    function pauseAdapter(address adapter) external onlyOwner {
        if (!isRegisteredAdapter[adapter]) revert AdapterNotRegistered();
        pausedAdapters[adapter] = true;
        emit AdapterPaused(adapter);
    }

    /// @notice Unpause an adapter (owner only)
    function unpauseAdapter(address adapter) external onlyOwner {
        if (!isRegisteredAdapter[adapter]) revert AdapterNotRegistered();
        pausedAdapters[adapter] = false;
        emit AdapterUnpaused(adapter);
    }

    /// @notice Transfer ownership (owner only)
    /// @dev Disallows the zero address to avoid permanently bricking the
    ///      factory (no pause/unpause, no staleness updates, no further
    ///      ownership transfer possible). Single-step typo protection.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Update default max staleness (owner only)
    function setDefaultMaxStaleness(uint256 newStaleness) external onlyOwner {
        _requireStalenessInRange(newStaleness);
        emit DefaultMaxStalenessUpdated(defaultMaxStaleness, newStaleness);
        defaultMaxStaleness = newStaleness;
    }

    /// @notice Total number of deployed adapters
    function adapterCount() external view returns (uint256) {
        return allAdapters.length;
    }

    function _requireStalenessInRange(uint256 s) private pure {
        if (s < MIN_STALENESS || s > MAX_STALENESS) revert StalenessOutOfRange(s);
    }
}
