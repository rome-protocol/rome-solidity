// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Trap mocks for the wrapper hot-path tests
///        (`tests/erc20spl/hot-path.test.ts`, `tests/erc20spl/cached-hot-path.test.ts`).
///
/// @dev A warm ERC-20 transfer through a wrapper must reach exactly one
///      precompile write (the SPL move). Everything else this file traps was
///      being paid on every transfer for nothing: an `ERC20Users` registration
///      nobody reads, a `mint_info` read on a mint that can never carry a fee,
///      and a recipient-ATA existence probe after the wrapper already learned
///      the ATA exists. Each trap is a REVERTING flag on a shared ledger: armed
///      by an ordinary tx between two calls under test, it turns "the hot path
///      still reaches X" into a revert — the same signal
///      `AtaCreatedFlagMocks.sol` uses, because a counter cannot observe a
///      STATICCALL'd view.
///
///      The ledger holds all state. The precompile stand-ins are installed with
///      `hardhat_setCode` (code only, fresh storage) and are reached both by
///      CALL/STATICCALL and by `delegatecall` (create_ata), so they keep no
///      storage of their own: the ledger address is an immutable baked into
///      their code.
contract HotPathLedger {
    mapping(bytes32 => bool) public created;
    bool public mintInfoTrapArmed;
    bool public accountReadTrapArmed;
    bool public createTrapArmed;
    bool public pdaTrapArmed;
    /// What `mint_info` reports for every mint: `extensions` bit 1 is
    /// TransferFeeConfig (ExtensionType discriminant 1), `feeBps` the armed fee.
    uint32 public extensions;
    uint16 public feeBps;

    function recordCreated(bytes32 ata) external { created[ata] = true; }
    function setMintInfoTrap(bool armed) external { mintInfoTrapArmed = armed; }
    function setAccountReadTrap(bool armed) external { accountReadTrapArmed = armed; }
    function setCreateTrap(bool armed) external { createTrapArmed = armed; }
    function setPdaTrap(bool armed) external { pdaTrapArmed = armed; }
    function setMint(uint32 extensions_, uint16 feeBps_) external {
        extensions = extensions_;
        feeBps = feeBps_;
    }
}

/// @notice `ERC20Users` stand-in with the same ABI. Reverts when armed, which
///         is how the tests prove the wrapper's transfer path no longer
///         registers callers.
contract TrappingUsers {
    bool public armed;
    mapping(address => bytes32) private _seen;

    function setArmed(bool armed_) external { armed = armed_; }

    function ensure_user(address user) external returns (bytes32) {
        if (armed) {
            revert("ERC20Users.ensure_user fired - the wrapper hot path must not register callers");
        }
        bytes32 key = keccak256(abi.encodePacked("mock-pda", user));
        _seen[user] = key;
        return key;
    }

    function get_user(address user) external view returns (bytes32) {
        return _seen[user];
    }
}

/// @notice Installed at HELPER (0xff..09), SPL_CACHED (0xff..05) and CPI
///         (0xff..08). One code blob serves all three: the selectors the
///         wrappers use do not collide across those interfaces.
contract HotPathPrecompileMock {
    struct Account {
        bytes32 mint;
        bytes32 owner;
        uint64 amount;
        bytes32 delegate;
        uint8 state;
        bool is_native;
        uint64 native_value;
        uint64 delegated_amount;
        bytes32 close_authority;
    }

    HotPathLedger public immutable ledger;

    constructor(HotPathLedger ledger_) {
        ledger = ledger_;
    }

    // ── mint facts (HELPER and SplCached share the selector) ────────────────

    function mint_info(bytes32)
        external
        view
        returns (bytes32 tokenProgram, uint8 decimals, bytes32 hookProgram, uint16 fee, uint32 ext)
    {
        if (ledger.mintInfoTrapArmed()) {
            revert("mint_info fired - the hot path must not read the mint on a fee-incapable wrapper");
        }
        return (bytes32(0), 6, bytes32(0), ledger.feeBps(), ledger.extensions());
    }

    function ata(address user, bytes32 mint) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("mock-ata", user, mint));
    }

    function pda(address user) external view returns (bytes32) {
        if (ledger.pdaTrapArmed()) {
            revert("pda fired - the hot path must not re-derive a fixed PDA");
        }
        return keccak256(abi.encodePacked("mock-pda", user));
    }

    /// Every caller is the wrapper's delegate — `isEnabled` reads true.
    function allowance_of(address, address, bytes32) external pure returns (uint64) {
        return type(uint64).max;
    }

    function user_balance(address, bytes32) external view returns (uint64) {
        if (ledger.accountReadTrapArmed()) {
            revert("user_balance fired - the hot path must not read a balance without an armed fee");
        }
        return 0;
    }

    // ── legacy CPI-track ops (HELPER) ───────────────────────────────────────

    /// Reached via `delegatecall`; records through a plain call into the
    /// ledger so the write lands in the ledger's storage, not the caller's.
    function create_ata(address user, bytes32 mint) external {
        if (ledger.createTrapArmed()) {
            revert("create_ata fired - flag fast-path should have skipped the create");
        }
        ledger.recordCreated(ata(user, mint));
    }

    function transfer_spl(address, address, uint64, bytes32) external {}
    function transfer_spl(address, uint64, bytes32) external {}

    // ── CPI reads (0xff..08) ────────────────────────────────────────────────

    function account_lamports(bytes32 account_) external view returns (uint64) {
        if (ledger.accountReadTrapArmed()) {
            revert("account_lamports (lamportsOf) fired - flag fast-path should have skipped the probe");
        }
        return ledger.created(account_) ? uint64(1) : uint64(0);
    }

    // ── cached track (0xff..05) ─────────────────────────────────────────────

    /// Reverts for an ATA the ledger has not seen — the shape `SplCached.account`
    /// has on Rome for a missing account, which is what the wrappers' try/catch
    /// keys on.
    function account(address user, bytes32 mint) external view returns (Account memory acc) {
        if (ledger.accountReadTrapArmed()) {
            revert("SplCached.account fired - flag fast-path should have skipped the probe");
        }
        if (!ledger.created(ata(user, mint))) {
            revert("no account");
        }
        acc.amount = 1;
    }

    function transferFrom(address, address, uint256, bytes32) external {}
    function transfer(address, uint256, bytes32) external {}
}

/// @notice Installed at ASSOCIATED_SPL_CACHED (0xff..06); `create_ata` is
///         reached via `delegatecall` from the cached wrapper.
contract HotPathAssocMock {
    HotPathLedger public immutable ledger;

    constructor(HotPathLedger ledger_) {
        ledger = ledger_;
    }

    function create_ata(address user, bytes32 mint) external {
        if (ledger.createTrapArmed()) {
            revert("create_ata fired - flag fast-path should have skipped the create");
        }
        ledger.recordCreated(keccak256(abi.encodePacked("mock-ata", user, mint)));
    }
}
