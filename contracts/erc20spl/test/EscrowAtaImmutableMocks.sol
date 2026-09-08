// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISplCached} from "../../interface.sol";

/// @title Precompile stand-ins for the escrow-ATA-immutable optimization
///        (`escrow-ata-immutable.test.ts`).
///
/// @dev Both wrapper families derive their own escrow ATA once at
///      construction instead of re-deriving it on every contract-destined
///      transfer, caching the existence probe behind a monotone flag —
///      same shape as `AtaCreatedFlagMocks.sol`'s per-user fast path, one
///      level up (the wrapper's own ATA, not an arbitrary user's). Uses
///      the same REVERTING TRAP technique — see that file's header.
contract EscrowAtaLedger {
    // Legacy track: ATA pubkey -> created. Keyed identically to
    // `AtaCreatedFlagLedger.created` (both derive via the mock's own
    // `ata()` function), kept separate so the two suites never share state.
    mapping(bytes32 => bool) public createdAta;
    // Cached track: keccak(user, mint) -> created (SplCached.account has no
    // raw-ATA-pubkey overload in this mock; keying on the inputs is enough).
    mapping(bytes32 => bool) public createdAccount;

    // Must never fire post-construction: proves the escrow ATA is derived
    // exactly once (in the constructor), not recomputed on every transfer.
    bool public ataTrapArmed;
    // Legacy: the AccountReader.lamportsOf existence probe — must fire at
    // most once per wrapper instance.
    bool public lamportsTrapArmed;
    // Cached: the SplCached.account existence probe — must fire at most
    // once per wrapper instance.
    bool public accountTrapArmed;
    // Both tracks: the create_ata delegatecall itself — must never fire
    // once the wrapper has confirmed its escrow ATA exists.
    bool public createTrapArmed;

    function setAtaTrap(bool armed) external { ataTrapArmed = armed; }
    function setLamportsTrap(bool armed) external { lamportsTrapArmed = armed; }
    function setAccountTrap(bool armed) external { accountTrapArmed = armed; }
    function setCreateTrap(bool armed) external { createTrapArmed = armed; }

    function recordCreatedAta(bytes32 ata) external { createdAta[ata] = true; }
    function recordCreatedAccount(bytes32 key) external { createdAccount[key] = true; }
}

/// @notice Installed at HELPER (`0xff...09`). Backs the legacy wrapper's
///         constructor (`mint_info`) + `_ensureWrapperAta` (`ata`,
///         `create_ata` via delegatecall) + `_transfer`'s EOA-leg CPI
///         (`transfer_spl`). Also backs the cached wrapper's
///         `_ensureWrapperAta` `ata` derivation — an EthCall, legal from
///         either track.
contract EscrowAtaHelperMock {
    EscrowAtaLedger public immutable ledger;

    constructor(EscrowAtaLedger _ledger) {
        ledger = _ledger;
    }

    /// Admits any mint: unarmed hook, legacy token program, zero fee — this
    /// fixture runs feeBps=0, so the fee-delta branch in `_transfer` takes
    /// its zero-cost path and needs no further mocking.
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

    /// Called legitimately exactly once, from the wrapper's own
    /// constructor; any call reached after the trap is armed is the
    /// regression this optimization removes.
    function ata(address user, bytes32 mint) external view returns (bytes32) {
        if (ledger.ataTrapArmed()) {
            revert("HelperProgram.ata fired post-construction - escrow ATA must be a constructor-derived immutable");
        }
        return keccak256(abi.encodePacked("mock-ata", user, mint));
    }

    /// Reached via `delegatecall`; records via a plain call into the
    /// ledger so the write lands in the ledger's own storage.
    function create_ata(address user, bytes32 mint) external {
        if (ledger.createTrapArmed()) {
            revert("create_ata fired - escrow-created flag fast path should have skipped this");
        }
        bytes32 derived = keccak256(abi.encodePacked("mock-ata", user, mint));
        ledger.recordCreatedAta(derived);
    }

    /// No-op success for the legacy wrapper's EOA-leg SPL move — the
    /// escrow-ATA optimization doesn't touch this call, it just must not
    /// revert so `_transfer` reaches its ledger side-effects.
    function transfer_spl(address, address, uint64, bytes32) external pure returns (bool) {
        return true;
    }
}

/// @notice Installed at CPI (`0xff...08`). Backs
///         `AccountReader.lamportsOf` (-> `CpiProgram.account_lamports`) —
///         the legacy escrow-ATA existence probe.
contract EscrowAtaCpiMock {
    EscrowAtaLedger public immutable ledger;

    constructor(EscrowAtaLedger _ledger) {
        ledger = _ledger;
    }

    function account_lamports(bytes32 account) external view returns (uint64) {
        if (ledger.lamportsTrapArmed()) {
            revert("account_lamports (lamportsOf) fired - escrow-created flag fast path should have skipped this");
        }
        return ledger.createdAta(account) ? uint64(1) : uint64(0);
    }
}

/// @notice Installed at `SplCached` (`0xff...05`). Backs the cached
///         wrapper's constructor (`mint_info`) and `_ensureWrapperAta`'s
///         overlay-aware existence probe (`account`).
contract EscrowAtaSplCachedMock {
    EscrowAtaLedger public immutable ledger;

    constructor(EscrowAtaLedger _ledger) {
        ledger = _ledger;
    }

    function mint_info(bytes32)
        external
        pure
        returns (bytes32 tokenProgram, uint8 decimals, bytes32 hookProgram, uint16 feeBps, uint32 extensions)
    {
        return (bytes32(0), 6, bytes32(0), 0, 0);
    }

    /// Reverts (simulating `try/catch`'s catch branch) until the matching
    /// `create_ata` has run; then returns a minimal valid `Account`.
    function account(address user, bytes32 mint) external view returns (ISplCached.Account memory) {
        if (ledger.accountTrapArmed()) {
            revert("SplCached.account fired - escrow-created flag fast path should have skipped this probe");
        }
        bytes32 key = keccak256(abi.encodePacked(user, mint));
        require(ledger.createdAccount(key), "no account");
        return ISplCached.Account({
            mint: mint,
            owner: keccak256(abi.encodePacked("mock-owner", user)),
            amount: 0,
            delegate: bytes32(0),
            state: ISplCached.AccountState.Initialized,
            is_native: false,
            native_value: 0,
            delegated_amount: 0,
            close_authority: bytes32(0)
        });
    }

    /// No-op success for the cached wrapper's EOA-leg SPL move.
    function transferFrom(address, address, uint256, bytes32) external pure returns (bool) {
        return true;
    }
}

/// @notice Installed at `AssociatedSplCached` (`0xff...06`). Backs the
///         cached wrapper's `_ensureWrapperAta` create leg.
contract EscrowAtaAssocSplCachedMock {
    EscrowAtaLedger public immutable ledger;

    constructor(EscrowAtaLedger _ledger) {
        ledger = _ledger;
    }

    function create_ata(address user, bytes32 mint) external {
        if (ledger.createTrapArmed()) {
            revert("AssociatedSplCached.create_ata fired - escrow-created flag fast path should have skipped this");
        }
        ledger.recordCreatedAccount(keccak256(abi.encodePacked(user, mint)));
    }
}
