// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./PythPullParser.sol";
import "./BookFeedAdapter.sol";
import {CpiProgram} from "../interface.sol";

/// @title PriceBook
/// @notice One aggregated oracle write, unchanged Chainlink reads
///         (spec: rome-specs active/technical/oracle-pricebook.md).
///
///         The book owns every registered feed's cache; per-feed
///         BookFeedAdapter clones are stateless view facades. The keeper (or
///         anyone — `refreshAll` is permissionless and grief-safe: the only
///         input is which registered feeds to attempt) submits the roster in
///         measured-width chunks; each feed is an independent branch-isolated
///         unit — one bad feed never reverts the batch, and the batch reverts
///         only when every attempted feed faulted.
///
///         Write-path invariants (R1–R4): verified source (owner, registered
///         account, discriminator, Full variant, parsed feed id == registered
///         id), monotonic publishTime (older/equal → healthy skip), future
///         publishTime → fault (a committed future timestamp would wedge the
///         feed against monotonicity), value bounds → fault with no write
///         (prior entry keeps serving until it ages out), pause → healthy
///         write-side skip AND a fail-closed read: the served entry's status
///         flips to paused (answer/publishTime/cachedAt retained) so reads
///         revert immediately instead of aging out; unpause re-refreshes and
///         only resumes serving when the source is strictly newer than the
///         retained entry and fresh within maxStaleness — any failure rolls
///         back atomically, leaving the feed paused.
///
///         Cheap-skip: a bound feed on the fast path pre-reads publish_time
///         (one u64) and skips before the full fetch + parse. The pre-read
///         trusts Full-variant offsets, so it is bypassed once the entry's age
///         exceeds half the feed's staleness window — a feed drifting toward
///         staleness always gets the full validated read.
contract PriceBook {
    struct Registration {
        bytes32 expectedFeedId; // Pyth feed id the source account must carry
        address adapter; // the feed's BookFeedAdapter clone
        uint16 maxConfBps; // conf/price bound, bps
        uint32 halfWindowSec; // cheap-skip bypass threshold (maxStaleness/2)
        uint32 maxStaleness; // exact bound (halfWindowSec halves it, losing the odd second) — unpause freshness gate matches BookFeedAdapter's read gate to the second
    }

    address public owner;
    bytes32 public immutable pythReceiverProgramId;
    address public immutable adapterImplementation;

    mapping(bytes32 => Registration) internal _regs;
    /// Entry slot: price8 int64 | publishTime u64 <<64 | cachedAt u64 <<128 | status u8 <<192.
    mapping(bytes32 => uint256) internal _entries;
    bytes32[] internal _accounts; // registration order — the keeper's roster
    mapping(address => bytes32) public accountOfAdapter; // pause ops reject unknown addresses
    mapping(address => bool) internal _paused;

    uint16 public constant DEFAULT_MAX_CONF_BPS = 200; // legacy adapters' constant
    uint8 private constant STATUS_PAUSED = 2; // entry status byte: 0 = never written, 1 = live, 2 = paused
    uint256 private constant OUTCOME_COMMIT = 0;
    uint256 private constant OUTCOME_SKIP = 1;
    uint256 private constant OUTCOME_FAULT = 2;

    event FeedRegistered(bytes32 indexed sourceAccount, bytes32 feedId, address adapter);
    event FeedRefreshed(bytes32 indexed sourceAccount, bytes32 feedId, int256 answer, uint64 publishTime);
    event FeedSkippedNotNewer(bytes32 indexed sourceAccount, uint64 storedPublishTime);
    event FeedSkippedPaused(bytes32 indexed sourceAccount);
    event FeedRefreshFailed(bytes32 indexed sourceAccount, bytes4 reason);
    event AdapterPauseSet(address indexed adapter, bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error AlreadyRegistered();
    error InvalidSourceOwner();
    error StalenessOutOfRange(uint256 staleness);
    error ConfBpsOutOfRange(uint256 bps);
    error NotARegisteredAdapter();
    error UnpauseSourceNotNewer();
    error UnpauseStalePrice();
    error UnpauseRefreshFailed(bytes4 reason);
    error RegistrationRefreshFailed(bytes4 reason);
    error AllFeedsFaulted();
    // per-feed fault reasons (also surfaced via FeedRefreshFailed)
    error UnregisteredFeed();
    error FetchFailed();
    error FeedIdMismatch();
    error FuturePublishTime();
    error NonPositivePrice();
    error ConfidenceExceedsThreshold();
    error NormalizationOverflow();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(bytes32 _pythReceiverProgramId, address _adapterImplementation) {
        owner = msg.sender;
        pythReceiverProgramId = _pythReceiverProgramId;
        adapterImplementation = _adapterImplementation;
    }

    // ── registration (owner-gated; ends with the feed's solo first refresh) ──

    /// @notice Register a feed: validate the source account, deploy its
    ///         adapter clone, and perform the solo first refresh inline — a
    ///         feed is never registered in a state where its adapter would
    ///         serve `UninitializedPriceFeed`, and cold writes never ride a
    ///         keeper tick chunk.
    function registerFeed(
        bytes32 sourceAccount,
        bytes32 expectedFeedId,
        uint256 maxConfBps,
        string calldata desc,
        uint256 maxStaleness
    ) external onlyOwner returns (address adapter) {
        if (_regs[sourceAccount].adapter != address(0)) revert AlreadyRegistered();
        if (maxStaleness < 1 || maxStaleness > 24 hours) revert StalenessOutOfRange(maxStaleness);
        if (maxConfBps > 10_000) revert ConfBpsOutOfRange(maxConfBps);
        if (_accountOwner(sourceAccount) != pythReceiverProgramId) revert InvalidSourceOwner();

        adapter = Clones.clone(adapterImplementation);
        BookFeedAdapter(adapter).initialize(address(this), sourceAccount, desc, maxStaleness);

        _regs[sourceAccount] = Registration({
            expectedFeedId: expectedFeedId,
            adapter: adapter,
            maxConfBps: maxConfBps == 0 ? DEFAULT_MAX_CONF_BPS : uint16(maxConfBps),
            halfWindowSec: uint32(maxStaleness / 2),
            maxStaleness: uint32(maxStaleness)
        });
        _accounts.push(sourceAccount);
        accountOfAdapter[adapter] = sourceAccount;

        (uint256 outcome, bytes4 reason) = _refreshOne(sourceAccount, true);
        if (outcome != OUTCOME_COMMIT) revert RegistrationRefreshFailed(reason);
        emit FeedRegistered(sourceAccount, expectedFeedId, adapter);
    }

    // ── the aggregated write ────────────────────────────────────────────

    /// @notice Refresh the given registered feeds in one transaction.
    ///         Permissionless. Per-feed branch isolation; reverts only when
    ///         every attempted feed faulted (all-skip is healthy). An empty
    ///         list is a no-op.
    function refreshAll(bytes32[] calldata sourceAccounts)
        external
        returns (uint256 committed, uint256 skipped, uint256 faulted)
    {
        for (uint256 i = 0; i < sourceAccounts.length; i++) {
            (uint256 outcome, bytes4 reason) = _refreshOne(sourceAccounts[i], false);
            if (outcome == OUTCOME_COMMIT) {
                committed++;
            } else if (outcome == OUTCOME_SKIP) {
                skipped++;
            } else {
                faulted++;
                emit FeedRefreshFailed(sourceAccounts[i], reason);
            }
        }
        if (sourceAccounts.length > 0 && faulted == sourceAccounts.length) revert AllFeedsFaulted();
    }

    // ── views ───────────────────────────────────────────────────────────

    function entryOf(bytes32 sourceAccount)
        external
        view
        returns (int256 answer, uint64 publishTime, uint64 cachedAt, uint8 status)
    {
        uint256 packed = _entries[sourceAccount];
        answer = int256(int64(uint64(packed)));
        publishTime = uint64(packed >> 64);
        cachedAt = uint64(packed >> 128);
        status = uint8(packed >> 192);
    }

    function registrationOf(bytes32 sourceAccount) external view returns (Registration memory) {
        return _regs[sourceAccount];
    }

    function adapterOf(bytes32 sourceAccount) external view returns (address) {
        return _regs[sourceAccount].adapter;
    }

    function registrationCount() external view returns (uint256) {
        return _accounts.length;
    }

    function registrationAt(uint256 index) external view returns (bytes32) {
        return _accounts[index];
    }

    /// @notice IAdapterFactory-compatible pause lookup for the adapters.
    function isPaused(address adapter) external view returns (bool) {
        return _paused[adapter];
    }

    // ── admin ───────────────────────────────────────────────────────────

    function pauseAdapter(address adapter) external onlyOwner {
        bytes32 acct = accountOfAdapter[adapter];
        if (acct == bytes32(0)) revert NotARegisteredAdapter();
        _paused[adapter] = true;
        _entries[acct] = (_entries[acct] & ((uint256(1) << 192) - 1)) | (uint256(STATUS_PAUSED) << 192);
        emit AdapterPauseSet(adapter, true);
    }

    /// @notice Unpause and re-validate against the live source in one step.
    ///         A no-op if the adapter isn't currently paused — safe to
    ///         include in a bulk/blind unpause without checking state first.
    ///         Otherwise reverts (rolling back `_paused` and the entry
    ///         together) unless the source is strictly newer than the
    ///         retained entry AND fresh within `maxStaleness` — pause/unpause
    ///         never resurrects a stale or non-newer price.
    function unpauseAdapter(address adapter) external onlyOwner {
        bytes32 acct = accountOfAdapter[adapter];
        if (acct == bytes32(0)) revert NotARegisteredAdapter();
        if (!_paused[adapter]) return;
        _paused[adapter] = false;
        (uint256 outcome, bytes4 reason) = _refreshOne(acct, false);
        if (outcome == OUTCOME_SKIP) revert UnpauseSourceNotNewer();
        if (outcome != OUTCOME_COMMIT) revert UnpauseRefreshFailed(reason);
        uint64 publishTime = uint64(_entries[acct] >> 64);
        if (block.timestamp - publishTime > _regs[acct].maxStaleness) revert UnpauseStalePrice();
        emit AdapterPauseSet(adapter, false);
    }

    /// @dev Direct transfer (no two-step): mirrors OracleAdapterFactory.
    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ── per-feed unit: branches only, nothing here may revert ───────────

    function _refreshOne(bytes32 acct, bool isRegistration) internal returns (uint256 outcome, bytes4 reason) {
        Registration storage reg = _regs[acct];
        if (reg.adapter == address(0)) return (OUTCOME_FAULT, UnregisteredFeed.selector);
        if (_paused[reg.adapter]) {
            emit FeedSkippedPaused(acct);
            return (OUTCOME_SKIP, 0);
        }

        uint256 packed = _entries[acct];
        uint8 status = uint8(packed >> 192);
        uint64 storedPt = uint64(packed >> 64);

        // Cheap-skip: only while the entry is comfortably fresh (age within
        // half the staleness window); beyond that, always take the full
        // validated read (the pre-read trusts Full-variant offsets).
        if (status != 0 && !isRegistration && block.timestamp - storedPt <= reg.halfWindowSec) {
            (bool peeked, uint64 livePt) = _peekPublishTime(acct);
            if (peeked && livePt <= storedPt) {
                emit FeedSkippedNotNewer(acct, storedPt);
                return (OUTCOME_SKIP, 0);
            }
        }

        (bool ok, bytes memory data) = _fetchRaw(acct);
        if (!ok) return (OUTCOME_FAULT, FetchFailed.selector);
        (bool pok, bytes4 perr, int64 price, uint64 conf, int32 expo, uint64 publishTime, bytes32 feedId) =
            _parseFast(data);
        if (!pok) return (OUTCOME_FAULT, perr);

        if (feedId != reg.expectedFeedId) return (OUTCOME_FAULT, FeedIdMismatch.selector);
        if (publishTime > block.timestamp) return (OUTCOME_FAULT, FuturePublishTime.selector);
        if (status != 0 && publishTime <= storedPt) {
            emit FeedSkippedNotNewer(acct, storedPt);
            return (OUTCOME_SKIP, 0);
        }
        if (price <= 0) return (OUTCOME_FAULT, NonPositivePrice.selector);
        if (uint256(conf) * 10_000 > uint256(uint64(price)) * reg.maxConfBps) {
            return (OUTCOME_FAULT, ConfidenceExceedsThreshold.selector);
        }
        (bool nok, int64 price8) = _normalize64(price, expo);
        if (!nok) return (OUTCOME_FAULT, NormalizationOverflow.selector);

        _entries[acct] = uint256(uint64(price8)) | (uint256(publishTime) << 64)
            | (uint256(uint64(block.timestamp)) << 128) | (uint256(1) << 192);
        emit FeedRefreshed(acct, feedId, int256(price8), publishTime);
        return (OUTCOME_COMMIT, 0);
    }

    /// @dev Assembly PriceUpdateV2 parse: discriminator + Full-variant guard,
    ///      one mload + byteswap per needed field (EMA fields never touched).
    ///      Byte-equivalent to PythPullParser.parse for the fields the book
    ///      uses; reuses the parser's error selectors.
    function _parseFast(bytes memory data)
        internal
        pure
        returns (bool ok, bytes4 err, int64 price, uint64 conf, int32 expo, uint64 publishTime, bytes32 feedId)
    {
        if (data.length < PythPullParser.MIN_DATA_LENGTH) {
            return (false, PythPullParser.PythPullDataTooShort.selector, 0, 0, 0, 0, 0);
        }
        bool discOk;
        bool variantOk;
        uint64 rawPrice;
        uint64 rawConf;
        uint32 rawExpo;
        uint64 rawPt;
        assembly {
            function le64(w) -> v {
                let x := shr(192, w)
                v :=
                    or(
                        or(
                            or(and(shr(56, x), 0xff), and(shr(40, x), 0xff00)),
                            or(and(shr(24, x), 0xff0000), and(shr(8, x), 0xff000000))
                        ),
                        or(
                            or(and(shl(8, x), 0xff00000000), and(shl(24, x), 0xff0000000000)),
                            or(and(shl(40, x), 0xff000000000000), shl(56, and(x, 0xff)))
                        )
                    )
            }
            let p := add(data, 0x20)
            discOk := eq(shr(192, mload(p)), 0x22f123639d7ef4cd)
            variantOk := eq(byte(0, mload(add(p, 40))), 0x01)
            feedId := mload(add(p, 41))
            rawPrice := le64(mload(add(p, 73)))
            rawConf := le64(mload(add(p, 81)))
            let y := shr(224, mload(add(p, 89)))
            rawExpo :=
                or(
                    or(and(shr(24, y), 0xff), and(shr(8, y), 0xff00)),
                    or(and(shl(8, y), 0xff0000), shl(24, and(y, 0xff)))
                )
            rawPt := le64(mload(add(p, 93)))
        }
        if (!discOk) return (false, PythPullParser.InvalidPythPullAccount.selector, 0, 0, 0, 0, 0);
        if (!variantOk) return (false, PythPullParser.UnsupportedVerificationVariant.selector, 0, 0, 0, 0, 0);
        return (true, 0, int64(rawPrice), rawConf, int32(rawExpo), rawPt, feedId);
    }

    /// @dev Normalize to the Chainlink 8-decimal int64 answer, faulting (not
    ///      reverting) on overflow. Same math as the legacy adapters for every
    ///      sane exponent; guards keep the path revert-free.
    function _normalize64(int64 price, int32 expo) internal pure returns (bool ok, int64 price8) {
        int256 scaled = int256(price);
        int32 diff = expo + 8;
        if (diff > 0) {
            if (diff > 18) return (false, 0); // any int64 × 10^19 exceeds int64
            scaled = scaled * int256(10 ** uint32(diff));
        } else if (diff < 0) {
            if (diff < -76) return (false, 0); // legacy reverts on 10**77 — fault instead
            if (diff < -18) return (true, 0); // any int64 / 10^19 == 0 — match legacy
            scaled = scaled / int256(10 ** uint32(-diff));
        }
        if (scaled > type(int64).max || scaled < type(int64).min) return (false, 0);
        return (true, int64(scaled));
    }

    // ── account reads (virtual for the test harness) ────────────────────

    /// @dev Raw success-flagged read of the full PriceUpdateV2 prefix via the
    ///      account precompile; failure returns ok=false, never reverts.
    function _fetchRaw(bytes32 acct) internal view virtual returns (bool ok, bytes memory data) {
        address cpi = address(CpiProgram);
        uint256 want = PythPullParser.MIN_DATA_LENGTH;
        assembly {
            let m := mload(0x40)
            mstore(m, shl(224, 0x593762e8)) // account_data_at(bytes32,uint16,uint16)
            mstore(add(m, 4), acct)
            mstore(add(m, 36), 0)
            mstore(add(m, 68), want)
            ok := staticcall(gas(), cpi, m, 100, 0, 0)
            if ok {
                switch lt(returndatasize(), 0x40)
                case 1 { ok := 0 }
                default {
                    returndatacopy(m, 0x20, 0x20)
                    let len := mload(m)
                    switch lt(len, want)
                    case 1 { ok := 0 }
                    default {
                        data := m
                        mstore(data, len)
                        let padded := and(add(len, 31), not(31))
                        returndatacopy(add(data, 0x20), 0x40, padded)
                        mstore(0x40, add(add(data, 0x20), padded))
                    }
                }
            }
        }
    }

    /// @dev Cheap-skip pre-read: publish_time at offset 93 (Full-variant layout).
    function _peekPublishTime(bytes32 acct) internal view virtual returns (bool ok, uint64 publishTime) {
        try CpiProgram.account_u64_at(acct, 93) returns (uint64 pt) {
            return (true, pt);
        } catch {
            return (false, 0);
        }
    }

    /// @dev Solana owner of the source account (registration-time check).
    function _accountOwner(bytes32 acct) internal view virtual returns (bytes32 accountOwner) {
        (, accountOwner,,,,) = CpiProgram.account_info(acct);
    }
}
