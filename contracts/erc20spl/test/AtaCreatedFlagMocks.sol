// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AtaCreatedFlagLedger + precompile stand-ins for the ATA-created-flag
///        fast-path test (`ensure-token-account-created-flag.test.ts`).
///
/// @dev A call counter can't prove the lamportsOf read was skipped: it's a
///      STATICCALL (external view), and any storage write in its subtree
///      reverts. Instead, a REVERTING TRAP is armed by a separate ordinary
///      transaction between the two `ensure_token_account` calls under
///      test — reading the flag inside the STATICCALL is fine, but if the
///      probe fires while armed, the call reverts. Trap-armed-and-no-revert
///      is the load-bearing, mutation-provable signal that the fast path
///      fired.
///
///      `create_ata` is reached via `delegatecall`, so a plain state
///      variable here would SSTORE into the caller's (wrapper's) storage
///      instead of its own — `AtaCreatedFlagHelperMock` makes a plain
///      external call into this ledger contract instead, unaffected by the
///      caller's delegatecall context.
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
    function pda(address user) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("mock-pda", user));
    }

    function ata(address user, bytes32 mint) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("mock-ata", user, mint));
    }

    /// Reached via `delegatecall`; records via a plain call into the ledger
    /// so the write lands in the ledger's own storage, not the caller's.
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
