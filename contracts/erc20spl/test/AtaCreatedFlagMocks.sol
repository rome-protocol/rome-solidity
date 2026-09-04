// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AtaCreatedFlagLedger + precompile stand-ins for the ATA-created-flag
///        fast-path test (`ensure-token-account-created-flag.test.ts`).
///
/// @dev The real `SPL_ERC20.ensure_token_account` cannot be probed for "was
///      the lamportsOf read actually skipped" with a call counter: the read
///      goes out as `AccountReader.lamportsOf` -> `CpiProgram.account_lamports`,
///      an `external view` call, which Solidity compiles to a STATICCALL —
///      any storage write anywhere in that call's subtree reverts, so a mock
///      cannot count invocations of it from inside the call itself.
///
///      Instead this harness uses a REVERTING TRAP that is armed by a
///      separate, ordinary (non-view) transaction *between* the two
///      `ensure_token_account` calls under test. Reading the armed flag
///      inside the STATICCALL is fine (reads are never restricted); if the
///      probe fires while armed, the whole call reverts. So:
///        - trap disarmed + first call  -> probe executes normally, no revert.
///        - trap armed    + second call -> if the wrapper's fast path still
///          skips the probe (flag now true), the call succeeds; if the fast
///          path is missing/broken, the probe fires and the call reverts.
///      That revert-or-not is the load-bearing, mutation-provable signal.
///
///      `create_ata` is reached via `delegatecall` from the wrapper, so a
///      plain state variable in the mock installed at the precompile address
///      would SSTORE into the CALLER's (wrapper's) storage slots, not its
///      own — corrupting the wrapper under test. `AtaCreatedFlagHelperMock`
///      instead makes a plain (non-delegate) external call into this ledger
///      contract, which is unaffected by the caller's delegatecall context.
contract AtaCreatedFlagLedger {
    mapping(bytes32 => bool) public created;
    bool public lamportsTrapArmed;
    bool public createTrapArmed;

    function recordCreated(bytes32 ata) external {
        created[ata] = true;
    }

    function setLamportsTrap(bool armed) external {
        lamportsTrapArmed = armed;
    }

    function setCreateTrap(bool armed) external {
        createTrapArmed = armed;
    }
}

/// @notice Installed at HELPER (`0xff...09`) via `hardhat_setCode`. Backs
///         every HelperProgram call `SPL_ERC20`'s ctor + `ensure_token_account`
///         + `create_token_account` + `ERC20Users.ensure_user` need.
contract AtaCreatedFlagHelperMock {
    AtaCreatedFlagLedger public immutable ledger;

    constructor(AtaCreatedFlagLedger _ledger) {
        ledger = _ledger;
    }

    /// Admits any mint: unarmed hook, legacy token program, zero fee.
    function mint_info(bytes32)
        external
        pure
        returns (bytes32 tokenProgram, uint8 decimals, bytes32 hookProgram, uint16 feeBps, uint32 extensions)
    {
        return (bytes32(0), 6, bytes32(0), 0, 0);
    }

    /// `RomeEVMAccount.get_payer` / `ERC20Users.ensure_user` route here.
    /// Pure derive — no state needed, deterministic per user.
    function pda(address user) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("mock-pda", user));
    }

    /// Pure derive matching the real `ata(user, mint)` view — deterministic
    /// so the same (user, mint) always yields the same ATA address, exactly
    /// the property `ensure_token_account`'s fast path relies on.
    function ata(address user, bytes32 mint) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("mock-ata", user, mint));
    }

    /// Reached via `delegatecall` from `SPL_ERC20.create_token_account`.
    /// Records the (derived) ATA as created in the ledger via a plain call —
    /// NOT a state write in this contract's own storage, which under
    /// delegatecall would land in the caller's (wrapper's) storage instead.
    function create_ata(address user, bytes32 mint) external {
        if (ledger.createTrapArmed()) {
            revert("create_ata fired - flag fast-path should have skipped the create");
        }
        bytes32 derived = keccak256(abi.encodePacked("mock-ata", user, mint));
        ledger.recordCreated(derived);
    }
}

/// @notice Installed at CPI (`0xff...08`) via `hardhat_setCode`. Backs
///         `AccountReader.lamportsOf` (-> `CpiProgram.account_lamports`),
///         the exact per-transfer existence probe this optimization removes
///         from the wrapper's fast path.
contract AtaCreatedFlagCpiMock {
    AtaCreatedFlagLedger public immutable ledger;

    constructor(AtaCreatedFlagLedger _ledger) {
        ledger = _ledger;
    }

    function account_lamports(bytes32 account) external view returns (uint64) {
        if (ledger.lamportsTrapArmed()) {
            revert("account_lamports (lamportsOf) fired - flag fast-path should have skipped the probe");
        }
        return ledger.created(account) ? uint64(1) : uint64(0);
    }
}
