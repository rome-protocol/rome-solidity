// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title BridgePrecompileMock
/// @notice Stand-in for the HelperProgram (0xff..09), CpiProgram (0xff..08),
///         and SystemProgram (0xff..07) precompile tracks RomeBridgeWithdraw's
///         converted CPI sites reach — installed via `hardhat_setCode` at each
///         real precompile address (independent storage per install; see
///         `contracts/erc20spl/test/PrecompileMock.sol` for the same pattern),
///         so the contract is driven through a real call, not merely
///         constructed.
/// @dev `transfer_spl`'s authorization check is test-controlled rather than a
///      real SPL Token owner-or-delegate check (that check is enforced by
///      Solana's SPL Token program, not by Rome's precompile, and can't be
///      given behavioral fidelity from Solidity) — it exists so a test can
///      assert the bridge's OWN plumbing (which from_ata/caller it presents)
///      rather than SPL Token's authorization rule itself.
contract BridgePrecompileMock {
    struct Meta {
        bytes32 pubkey;
        bool is_signer;
        bool is_writable;
    }
    struct Seed {
        bytes item;
    }

    // ── HelperProgram track (0xff..09) ──────────────────────────────────

    mapping(bytes32 => bool) private _authorized; // keccak(from_ata,caller) => allowed

    address public lastTransferCaller;
    bytes32 public lastFromAta;
    bytes32 public lastToAta;
    uint64  public lastTransferTokens;
    bytes32 public lastTransferMint;
    uint256 public transferCount;

    address public lastApproveCaller;
    bytes32 public lastApproveAta;
    bytes32 public lastApproveDelegate;
    uint256 public approveCount;

    function ata(address user, bytes32 mint) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("bridge-mock-ata", user, mint));
    }

    function pda(address user) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("bridge-mock-pda", user));
    }

    function pda_with_salt(address user, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("bridge-mock-pda-salt", user, salt));
    }

    /// Test-only setter: authorize `caller` to move `from_ata` — mirrors "is
    /// owner or delegate of from_ata" without reimplementing SPL Token.
    function setAuthorized(bytes32 from_ata, address caller, bool ok) external {
        _authorized[keccak256(abi.encodePacked(from_ata, caller))] = ok;
    }

    /// Test-only: clears the call counters between tests that share this
    /// mock's storage (one install per suite, not per test — `hardhat_setCode`
    /// replaces code, not storage). Leaves `_authorized` alone; its keys are
    /// scoped by the caller address, which is a fresh contract per test.
    function reset() external {
        transferCount = 0;
        approveCount = 0;
        invokeSignedCount = 0;
    }

    /// transfer_spl(bytes32,bytes32,uint64,bytes32) — 0x766b362a. Reverts
    /// unless `msg.sender` was authorized (via `setAuthorized`) against
    /// `from_ata` — the delegate-or-owner gate SPL Token itself enforces on
    /// the real precompile.
    function transfer_spl(bytes32 from_ata, bytes32 to_ata, uint64 tokens, bytes32 mint) external {
        require(
            _authorized[keccak256(abi.encodePacked(from_ata, msg.sender))],
            "mock: caller neither owner nor delegate of from_ata"
        );
        lastTransferCaller = msg.sender;
        lastFromAta = from_ata;
        lastToAta = to_ata;
        lastTransferTokens = tokens;
        lastTransferMint = mint;
        transferCount += 1;
    }

    /// approve_spl_raw_delegate(bytes32,bytes32,uint64,bytes32,uint8) —
    /// 0x7881d453. Unconditionally records — the real precompile only
    /// requires the caller to own `ata`, which under a direct CALL is
    /// automatic (the caller signs as itself).
    function approve_spl_raw_delegate(bytes32 ata_, bytes32 delegate, uint64, bytes32, uint8) external {
        lastApproveCaller = msg.sender;
        lastApproveAta = ata_;
        lastApproveDelegate = delegate;
        approveCount += 1;
    }

    /// create_ata_for_key(bytes32,bytes32) — 0xd258a69d, the exempt
    /// delegatecall selector `ensureRecipientAta`/`ensureBridgeAta` use.
    /// Emits rather than records to storage: under delegatecall the emitting
    /// address is the CALLER (the bridge), so the event lands in the
    /// caller's own receipt logs with its arguments intact and assertable —
    /// storage writes here would instead land in the bridge's own slots.
    event CreateAtaForKey(bytes32 wallet, bytes32 mint);

    function create_ata_for_key(bytes32 wallet, bytes32 mint) external {
        emit CreateAtaForKey(wallet, mint);
    }

    /// Fixed legacy-SPL-Token, 6-decimal, no-hook, no-fee mint — enough for
    /// `UserPda.ataForKey`'s pure-Solidity ATA derivation.
    function mint_info(bytes32)
        external
        pure
        returns (bytes32 tokenProgram, uint8 decimals, bytes32 hookProgram, uint16 feeBps, uint32 extensions)
    {
        decimals = 6;
        tokenProgram = keccak256("bridge-mock-spl-token-program");
        hookProgram = bytes32(0);
        feeBps = 0;
        extensions = 0;
    }

    // ── CpiProgram track (0xff..08) ──────────────────────────────────────

    address public lastInvokeSignedCaller;
    bytes32 public lastInvokeSignedProgramId;
    uint256 public invokeSignedCount;
    Meta[] private _lastAccounts;
    bytes32[] private _lastSeeds;

    /// invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[]) —
    /// records the caller (proves direct CALL vs delegatecall) and the
    /// account plan, for per-site assertions.
    function invoke_signed(bytes32 program_id, Meta[] calldata accounts, bytes calldata, bytes32[] calldata seeds)
        external
    {
        lastInvokeSignedCaller = msg.sender;
        lastInvokeSignedProgramId = program_id;
        invokeSignedCount += 1;
        delete _lastAccounts;
        for (uint256 i = 0; i < accounts.length; ++i) {
            _lastAccounts.push(accounts[i]);
        }
        delete _lastSeeds;
        for (uint256 i = 0; i < seeds.length; ++i) {
            _lastSeeds.push(seeds[i]);
        }
    }

    function lastAccountsLength() external view returns (uint256) {
        return _lastAccounts.length;
    }

    function lastAccount(uint256 i) external view returns (bytes32 pubkey, bool is_signer, bool is_writable) {
        Meta storage m = _lastAccounts[i];
        return (m.pubkey, m.is_signer, m.is_writable);
    }

    // ── SystemProgram track (0xff..07) ───────────────────────────────────

    /// find_program_address — deterministic stand-in (not real Ed25519
    /// off-curve derivation), used by `PdaDeriver.derive` (denylist /
    /// wrapped_meta / custody PDAs) and by `UserPda.ataForKey`'s
    /// associated-token-address derivation.
    function find_program_address(bytes32 program, Seed[] calldata seeds)
        external
        pure
        returns (bytes32, uint8)
    {
        bytes memory acc_;
        for (uint256 i = 0; i < seeds.length; ++i) {
            acc_ = abi.encodePacked(acc_, seeds[i].item);
        }
        return (keccak256(abi.encodePacked(program, acc_)), uint8(255));
    }
}
