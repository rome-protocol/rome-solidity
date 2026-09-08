// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Precompile stand-ins for the cached-track `_ataCreated` parity fix
///        (`cached-ensure-token-account-created-flag.test.ts`).
///
/// @dev Mirrors `AtaCreatedFlagMocks.sol` for
///      `SPL_ERC20_cached.ensure_token_account`, which reaches
///      `AssociatedSplCached.create_ata` and needs no `lamportsOf`-style
///      probe — the journaled write itself, gated by `_ataCreated[user]`,
///      is the only thing worth skipping on repeat. See
///      `AtaCreatedFlagMocks.sol`'s header for the REVERTING TRAP technique.
contract CachedAtaCreatedFlagLedger {
    mapping(bytes32 => bool) public created;
    bool public createTrapArmed;

    function recordCreated(bytes32 ata) external {
        created[ata] = true;
    }

    function setCreateTrap(bool armed) external {
        createTrapArmed = armed;
    }
}

/// @notice Installed at HELPER (`0xff...09`) AND `SplCached` (`0xff...05`)
///         via `hardhat_setCode`. Backs `HelperProgram.ata` (used by
///         `ensure_token_account`'s return derivation) and `SplCached.
///         mint_info` (used by the constructor) — same mock code serves
///         both fixed addresses; each installation only ever receives the
///         calls its own precompile would.
contract CachedAtaCreatedFlagPrecompileMock {
    /// Admits any mint: unarmed hook, legacy token program, zero fee.
    function mint_info(bytes32)
        external
        pure
        returns (bytes32 tokenProgram, uint8 decimals, bytes32 hookProgram, uint16 feeBps, uint32 extensions)
    {
        return (bytes32(0), 6, bytes32(0), 0, 0);
    }

    function ata(address user, bytes32 mint) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("mock-ata", user, mint));
    }
}

/// @notice Installed at `AssociatedSplCached` (`0xff...06`) via
///         `hardhat_setCode`. Backs the exact per-user create the
///         `_ataCreated` flag skips on repeat.
contract CachedAtaCreatedFlagAssocMock {
    CachedAtaCreatedFlagLedger public immutable ledger;

    constructor(CachedAtaCreatedFlagLedger _ledger) {
        ledger = _ledger;
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
