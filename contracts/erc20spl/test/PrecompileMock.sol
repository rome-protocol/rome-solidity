// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SolanaConstants} from "../../cpi/SolanaConstants.sol";

/// @title PrecompileMock
/// @notice Stateful stand-in for the four precompile tracks a wrapper's
///         transfer path reaches — HelperProgram (0xff..09), CpiProgram
///         (0xff..08), SplCached (0xff..05), SystemProgram (0xff..07) —
///         so a wrapper can be deployed AND driven through a real transfer
///         on hardhat-network, not merely constructed.
/// @dev Installed via `hardhat_setCode` at one precompile address per
///      track; each install gets independent storage (`hardhat_setCode`
///      copies code, not storage), so state set through one address is
///      invisible to another. Existence probes (`account_lamports`,
///      `SplCached.account`) always answer as already-existing, since
///      these fixtures are about the transfer primitive, not ATA
///      bootstrap.
contract PrecompileMock {
    struct Meta {
        bytes32 pubkey;
        bool is_signer;
        bool is_writable;
    }
    struct Seed {
        bytes item;
    }
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

    /// Imported, not restated: must match what the hooked wrapper compares
    /// against, or every fixture fails closed on `Token2022MintRequired`.
    bytes32 public constant TOKEN_2022_PROGRAM = SolanaConstants.TOKEN_2022_PROGRAM;

    // ── HelperProgram track (0xff..09) ─────────────────────────────────

    mapping(bytes32 => uint64) private _userBalance;

    /// Layout of the mint id, most-significant byte first (same convention
    /// as `MintInfoMock`): byte 0 decimals, byte 1 non-zero arms the
    /// transfer hook, bytes 2-3 transfer fee bps (big-endian).
    function mint_info(bytes32 mint)
        external
        pure
        returns (bytes32 tokenProgram, uint8 decimals, bytes32 hookProgram, uint16 feeBps, uint32 extensions)
    {
        decimals = uint8(mint[0]);
        hookProgram = mint[1] == 0
            ? bytes32(0)
            : keccak256(abi.encodePacked("precompile-mock-hook", mint));
        feeBps = (uint16(uint8(mint[2])) << 8) | uint16(uint8(mint[3]));
        tokenProgram = TOKEN_2022_PROGRAM;
        extensions = hookProgram != bytes32(0) ? uint32(1) << 14 : 0;
    }

    function ata(address user, bytes32 mint) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("precompile-mock-ata", user, mint));
    }

    function pda(address user) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("precompile-mock-pda", user));
    }

    function user_balance(address account_, bytes32 mint) external view returns (uint64) {
        return _userBalance[keccak256(abi.encodePacked(account_, mint))];
    }

    /// Test-only setter — not part of any real precompile's ABI. Writes
    /// land in whichever address this contract's code was installed at,
    /// so call it against the HELPER install specifically.
    function setBalance(address account_, bytes32 mint, uint64 amount) external {
        _userBalance[keccak256(abi.encodePacked(account_, mint))] = amount;
    }

    function allowance_of(address, address, bytes32) external pure returns (uint64) {
        return 0;
    }

    // ── CpiProgram track (0xff..08) ─────────────────────────────────────

    Meta[] private _lastInvokeAccounts;
    bytes32 public lastInvokeProgramId;
    bytes public lastInvokeData;
    uint256 public invokeCount;

    /// Selector must stay `invoke(bytes32,(bytes32,bool,bool)[],bytes)` —
    /// `Token2022HookedTransfer.transferChecked` dispatches via
    /// `abi.encodeWithSignature`, keyed on that exact string, not on this
    /// struct's name.
    function invoke(bytes32 program_id, Meta[] calldata accounts, bytes calldata data) external {
        lastInvokeProgramId = program_id;
        lastInvokeData = data;
        invokeCount += 1;
        delete _lastInvokeAccounts;
        for (uint256 i = 0; i < accounts.length; ++i) {
            _lastInvokeAccounts.push(accounts[i]);
        }
    }

    function lastInvokeAccountsLength() external view returns (uint256) {
        return _lastInvokeAccounts.length;
    }

    function lastInvokeAccount(uint256 i)
        external
        view
        returns (bytes32 pubkey, bool is_signer, bool is_writable)
    {
        Meta storage m = _lastInvokeAccounts[i];
        return (m.pubkey, m.is_signer, m.is_writable);
    }

    /// Always non-zero: every ATA reads as already-existing, so
    /// `ensure_token_account`'s probe never falls through to
    /// `create_ata`. See the contract-level note above.
    function account_lamports(bytes32) external pure returns (uint64) {
        return 1_000_000;
    }

    function account_u64_at(bytes32, uint16) external pure returns (uint64) {
        return 0;
    }

    function account_data_at(bytes32, uint16, uint16) external pure returns (bytes memory) {
        return "";
    }

    // ── SplCached track (0xff..05) ──────────────────────────────────────

    /// Always succeeds: the cached wrapper's `_transfer` only falls
    /// through to `ensure_token_account` (and its `AssociatedSplCached`
    /// delegatecall, out of scope for this fixture) when this reverts.
    function account(address, bytes32) external pure returns (Account memory acc) {
        return acc;
    }

    function transferFrom(address, address, uint256, bytes32) external {}
    function transfer(address, uint256, bytes32) external {}

    // ── SystemProgram track (0xff..07) ──────────────────────────────────

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

    function base58_to_bytes32(bytes calldata) external pure returns (bytes32) {
        return keccak256("precompile-mock-base58");
    }
}
