// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {
    HelperProgram,
    SplCached,
    AssociatedSplCached,
    ISplCached
} from "../interface.sol";
import {AccountReader} from "../cpi/AccountReader.sol";
import {Convert} from "../convert.sol";
import {ERC20Users, ArmedTransferHookUnsupported} from "./erc20spl.sol";

/// @title  SPL_ERC20_cached
/// @notice Cache-based ERC20 wrapper around an SPL mint. Mutations dispatch
///         through the cached precompile family (SplCached, AssociatedSplCached)
///         so they revert atomically with the EVM tx.
/// @dev    One-track-per-contract: this contract performs no CPI Invoke, so
///         bridgeOutToSolana / ensureRecipientAta (which need the
///         permanently-CPI-only create_ata_for_key) are not exposed here.
contract SPL_ERC20_cached is IERC20, IERC20Metadata {
    address public immutable cpi_program;
    bytes32 public immutable mint_id;
    uint8 public immutable decimals;

    string private _name;
    string private _symbol;
    ERC20Users private _users;

    error ERC20InvalidApprover(address approver);
    error ERC20InvalidSpender(address spender);
    error ERC20InsufficientAllowance(
        address spender,
        uint256 currentAllowance,
        uint256 requiredAllowance
    );

    // A direct CALL to SplCached signs as external_auth(address(this)), not
    // the user's own authority, so the wrapper must be the user's one-time
    // SPL delegate. This mapping is a pure EVM allowance, decoupled from
    // that SPL-level grant.
    mapping(address => mapping(address => uint256)) private _allowances;

    // A contract can never call `approve`, so its SPL lives in this
    // wrapper's own ATA and is tracked here. Same CREATE2-counterfactual
    // note as erc20spl.sol: funds sent pre-deploy are not migrated into
    // `_escrow` if the address is later deployed to.
    mapping(address => uint256) private _escrow;

    // Once true, ATA existence is assumed forever (ATAs are never closed on
    // Rome). False always falls through to the unconditional (idempotent)
    // create_ata path, so an ATA that exists for any other reason is still
    // handled correctly.
    mapping(address => bool) private _ataCreated;

    // Fixed for the contract's life — derived once instead of re-deriving
    // via HelperProgram.ata on every contract-destined transfer.
    bytes32 public immutable escrow_ata;

    // Same monotone-existence argument as `_ataCreated` above.
    bool private _escrowAtaCreated;

    constructor(
        bytes32 _mint_id,
        address _cpi_program,
        string memory name_,
        string memory symbol_,
        ERC20Users users_
    ) {
        // Read on this contract's own track: once a cached invoke has fired,
        // verify_call refuses a legacy cross-state read. An armed hook is
        // refused too — the cached track can't stage one at all.
        (, uint8 mint_decimals, bytes32 hook_program, ,) = SplCached.mint_info(_mint_id);
        if (hook_program != bytes32(0)) {
            revert ArmedTransferHookUnsupported(_mint_id, hook_program);
        }
        cpi_program = _cpi_program;
        mint_id = _mint_id;
        decimals = mint_decimals;
        _name = name_;
        _symbol = symbol_;
        _users = users_;
        escrow_ata = HelperProgram.ata(address(this), _mint_id);
    }

    function name() external view returns (string memory) {
        return _name;
    }

    function symbol() external view returns (string memory) {
        return _symbol;
    }

    // ─── Read views — CPI CrossStateEthCall + EthCall ─────────────────────

    /// @notice Views must never revert (ERC-20 spec) — returns 0 for an
    ///         uninitialized mint instead of reverting.
    function totalSupply() external view returns (uint256) {
        if (AccountReader.lamportsOf(mint_id) == 0) {
            return 0;
        }
        return uint256(AccountReader.readU64At(mint_id, 36));
    }

    /// @notice ERC-20: balanceOf returns 0 (not revert) for any address.
    ///         Must use try/catch on `SplCached.account`, not a legacy
    ///         `AccountReader.lamportsOf` short-circuit — the legacy read
    ///         is not overlay-aware, so it can see a stale on-chain 0 in
    ///         the same tx as a cached-track write that already credited
    ///         the balance (breaks same-tx read-after-write callers, e.g.
    ///         a V3 pool's post-mint balance check).
    function balanceOf(address account) public view returns (uint256) {
        // A contract can't call `approve`; its balance is the escrow
        // ledger, not an on-chain read.
        if (account.code.length > 0) {
            return _escrow[account];
        }
        try SplCached.account(account, mint_id) returns (ISplCached.Account memory acc) {
            return uint256(acc.amount);
        } catch {
            return 0;
        }
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    /// @notice Whether `user` has sent the one-time SPL-level delegate
    ///         grant this wrapper needs to move their SPL. Reads via
    ///         `SplCached.account` (stays on this contract's cached
    ///         track) rather than the legacy `HelperProgram.allowance_of`.
    function isEnabled(address user) public view returns (bool) {
        try SplCached.account(user, mint_id) returns (ISplCached.Account memory acc) {
            return acc.delegate == HelperProgram.pda(address(this)) && acc.delegated_amount > 0;
        } catch {
            return false;
        }
    }

    /// @notice Pure derivation; never a track-locking event, never reverts.
    function get_token_account(address user) external view returns (bytes32) {
        return HelperProgram.ata(user, mint_id);
    }

    // ─── Mutating ERC-20 surface — all cache-based Invokes ────────────────

    /// @notice Idempotent ATA bootstrap. Always calls create unconditionally
    ///         (no existence probe) to keep this wrapper fully on the
    ///         cached track — a legacy-precompile read here would trip
    ///         `verify_call`'s one-track rule.
    function ensure_token_account(address user) public returns (bytes32) {
        bytes32 ata = HelperProgram.ata(user, mint_id);
        if (_ataCreated[user]) {
            return ata;
        }
        (bool ok, bytes memory result) = address(AssociatedSplCached).delegatecall(
            abi.encodeWithSignature(
                "create_ata(address,bytes32)",
                user,
                mint_id
            )
        );
        require(ok, string(Convert.revert_msg(result)));
        _ataCreated[user] = true;
        return ata;
    }

    /// @notice Public ATA-create entry; idempotent on repeat.
    function create_token_account(address user) external returns (bytes32) {
        _users.ensure_user(user);
        (bool ok, bytes memory result) = address(AssociatedSplCached).delegatecall(
            abi.encodeWithSignature(
                "create_ata(address,bytes32)",
                user,
                mint_id
            )
        );
        require(ok, string(Convert.revert_msg(result)));
        return HelperProgram.ata(user, mint_id);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        address spender = msg.sender;
        uint256 currentAllowance = _allowances[from][spender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < value) {
                revert ERC20InsufficientAllowance(spender, currentAllowance, value);
            }
            unchecked {
                _allowances[from][spender] = currentAllowance - value;
            }
        }
        return _transfer(from, to, value);
    }

    /// @dev The create must stay AssociatedSplCached (one-track rule), not
    ///      the legacy Helper form. Existence check runs at most once per
    ///      wrapper instance.
    function _ensureWrapperAta() internal returns (bytes32) {
        if (_escrowAtaCreated) {
            return escrow_ata;
        }
        try SplCached.account(address(this), mint_id) returns (ISplCached.Account memory) {
            _escrowAtaCreated = true;
            return escrow_ata;
        } catch {
            (bool ok, bytes memory result) = address(AssociatedSplCached).delegatecall(
                abi.encodeWithSignature("create_ata(address,bytes32)", address(this), mint_id)
            );
            require(ok, string(Convert.revert_msg(result)));
            _escrowAtaCreated = true;
            return escrow_ata;
        }
    }

    /// @dev Bypasses `balanceOf`'s contract branch (`_escrow[address(this)]`,
    ///      the wrong number for measuring the escrow ATA's own receipt).
    function _wrapperOnChainBalance() internal view returns (uint256) {
        try SplCached.account(address(this), mint_id) returns (ISplCached.Account memory acc) {
            return uint256(acc.amount);
        } catch {
            return 0;
        }
    }

    /// @dev Routes by whether an endpoint holds SPL under a signable PDA
    ///      (EOA, via the wrapper's delegate grant) or the wrapper's own
    ///      escrow ATA (contract) — not by caller identity.
    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");
        _users.ensure_user(msg.sender);

        bool fromIsContract = from.code.length > 0;
        bool toIsContract = to.code.length > 0;

        // Both ends already escrow-held: pure ledger move, no CPI.
        if (fromIsContract && toIsContract) {
            uint256 fromBal = _escrow[from];
            require(fromBal >= value, "insufficient escrow balance");
            _escrow[from] = fromBal - value;
            _escrow[to] += value;
            emit Transfer(from, to, value);
            return true;
        }

        if (fromIsContract) {
            require(_escrow[from] >= value, "insufficient escrow balance");
        }

        // Only pay for the destination read when a fee is armed; measured off
        // whichever ATA actually receives the SPL on-chain.
        (, , , uint16 feeBps, ) = SplCached.mint_info(mint_id);
        bool fee_armed = feeBps > 0;
        uint256 before = fee_armed
            ? (toIsContract ? _wrapperOnChainBalance() : balanceOf(to))
            : 0;

        if (toIsContract) {
            // The ATA that matters here is the wrapper's own, not `to`'s.
            _ensureWrapperAta();
        } else {
            // Skip the create round-trip when the recipient's ATA already
            // exists; overlay-aware so an ATA created earlier this tx counts.
            try SplCached.account(to, mint_id) returns (ISplCached.Account memory) {
            } catch {
                ensure_token_account(to);
            }
        }

        bool ok;
        bytes memory result;
        if (!fromIsContract) {
            // `from`'s SPL sits in `ata(external_auth(from))`; direct CALL
            // signs as external_auth(address(this)), so the wrapper must be
            // `from`'s SPL delegate. `to` collapses to address(this) when
            // the recipient is a contract (lands in this wrapper's escrow).
            address dest = toIsContract ? address(this) : to;
            (ok, result) = address(SplCached).call(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint256,bytes32)",
                    from, dest, value, mint_id
                )
            );
        } else {
            // `from`'s SPL already sits in this wrapper's own ATA; `transfer`
            // derives from_ata from context.caller, which under direct CALL
            // is the wrapper itself. No delegate needed.
            (ok, result) = address(SplCached).call(
                abi.encodeWithSignature(
                    "transfer(address,uint256,bytes32)",
                    to, value, mint_id
                )
            );
        }
        require(ok, string(Convert.revert_msg(result)));

        // Self-transfer needs the other direction: an armed fee debits
        // `value` and credits `value - fee`, so `after - before` would
        // underflow. Measuring the loss instead gives the delivered amount
        // in both directions, and self-transfer must not revert.
        uint256 delivered = value;
        if (fee_armed) {
            uint256 now_ = toIsContract ? _wrapperOnChainBalance() : balanceOf(to);
            delivered = to == from ? value - (before - now_) : now_ - before;
        }

        if (fromIsContract) {
            _escrow[from] -= value;
        }
        if (toIsContract) {
            _escrow[to] += delivered;
        }

        emit Transfer(from, to, delivered);
        return true;
    }

    /// @notice Pure EVM storage — decoupled from the SPL-level delegate
    ///         grant (see `isEnabled`). No u64 saturation sentinel needed.
    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) {
            revert ERC20InvalidSpender(address(0));
        }
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    // mint_to removed: a direct CALL can never be the mint authority. The
    // creator mints via SplCached.mint(address,uint256,bytes32) directly.
}
