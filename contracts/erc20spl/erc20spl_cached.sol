// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {
    HelperProgram,
    SplCached,
    AssociatedSplCached,
    ISplCached
} from "../interface.sol";
import {AccountReader} from "../cpi/AccountReader.sol";
import {Convert} from "../convert.sol";
import {ERC20Users, ArmedTransferHookUnsupported} from "./erc20spl.sol";

/// @title SPL_ERC20_cached
/// @notice ERC-20 wrapper over an SPL mint; every mutation goes through the cached precompiles,
///         so it reverts atomically with the EVM transaction.
/// @dev No raw-pubkey exits (`bridgeOutToSolana`, `ensureRecipientAta`): they need the CPI-only
///      `create_ata_for_key`.
contract SPL_ERC20_cached is IERC20, IERC20Metadata {
    address public immutable cpi_program;
    bytes32 public immutable mint_id;
    uint8 public immutable decimals;
    // TransferFeeConfig bit in `mint_info`'s extensions; fixed at mint creation, so only a
    // fee-capable wrapper reads the live fee per transfer.
    uint32 internal constant TRANSFER_FEE_CONFIG_EXTENSION_BIT = 1;
    bool public immutable fee_capable;

    string private _name;
    string private _symbol;
    ERC20Users private _users; // not read here; kept for the deploy ABI

    error ERC20InvalidApprover(address approver);
    error ERC20InvalidSpender(address spender);
    error ERC20InsufficientAllowance(
        address spender,
        uint256 currentAllowance,
        uint256 requiredAllowance
    );

    // Pure EVM allowance; separate from the user's one-time SPL delegate grant to this wrapper.
    mapping(address => mapping(address => uint256)) private _allowances;

    // A contract cannot approve, so its SPL sits in this wrapper's own ATA and is tracked here.
    // SPL sent to a not-yet-deployed CREATE2 address is not migrated when it deploys.
    mapping(address => uint256) private _escrow;

    // Once true, the ATA exists (never closed on Rome); false falls through to the create.
    mapping(address => bool) private _ataCreated;

    bytes32 public immutable escrow_ata;

    bool private _escrowAtaCreated;

    constructor(
        bytes32 _mint_id,
        address _cpi_program,
        string memory name_,
        string memory symbol_,
        ERC20Users users_
    ) {
        // Read on this contract's own track: after a cached invoke, a legacy cross-state read is
        // refused; an armed hook is refused too.
        (, uint8 mint_decimals, bytes32 hook_program, , uint32 extensions) = SplCached.mint_info(_mint_id);
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
        fee_capable = (extensions & (uint32(1) << TRANSFER_FEE_CONFIG_EXTENSION_BIT)) != 0;
    }

    function name() external view returns (string memory) {
        return _name;
    }

    function symbol() external view returns (string memory) {
        return _symbol;
    }

    /// @notice Never reverts (ERC-20): 0 for an uninitialised mint.
    function totalSupply() external view returns (uint256) {
        if (AccountReader.lamportsOf(mint_id) == 0) {
            return 0;
        }
        return uint256(AccountReader.readU64At(mint_id, 36));
    }

    /// @notice Never reverts. Uses `SplCached.account`, not `AccountReader.lamportsOf`, so a
    ///         same-transaction cached credit is visible. A contract's balance is its escrow
    ///         ledger.
    function balanceOf(address account) public view returns (uint256) {
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

    /// @notice True when `user` has granted this wrapper the SPL delegate it needs.
    function isEnabled(address user) public view returns (bool) {
        try SplCached.account(user, mint_id) returns (ISplCached.Account memory acc) {
            return acc.delegate == HelperProgram.pda(address(this)) && acc.delegated_amount > 0;
        } catch {
            return false;
        }
    }

    /// @notice The user's ATA address; never reverts, never creates it.
    function get_token_account(address user) external view returns (bytes32) {
        return HelperProgram.ata(user, mint_id);
    }

    /// @notice Creates the user's ATA if not known to exist (idempotent); returns its address.
    function ensure_token_account(address user) public returns (bytes32) {
        if (!_ataCreated[user]) {
            _createAta(user);
        }
        return HelperProgram.ata(user, mint_id);
    }

    /// @dev The one create site; sets the created-flag.
    function _createAta(address user) internal {
        (bool ok, bytes memory result) = address(AssociatedSplCached).delegatecall(
            abi.encodeWithSignature(
                "create_ata(address,bytes32)",
                user,
                mint_id
            )
        );
        require(ok, string(Convert.revert_msg(result)));
        _ataCreated[user] = true;
    }

    /// @notice Creates the user's ATA; idempotent.
    function create_token_account(address user) external returns (bytes32) {
        _createAta(user);
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

    /// @dev Creates this wrapper's escrow ATA at most once; AssociatedSplCached keeps it on the
    ///      cached track.
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

    /// @dev On-chain balance of this wrapper's ATA (`balanceOf` would return the ledger).
    function _wrapperOnChainBalance() internal view returns (uint256) {
        try SplCached.account(address(this), mint_id) returns (ISplCached.Account memory acc) {
            return uint256(acc.amount);
        } catch {
            return 0;
        }
    }

    /// @dev EOAs move SPL under their PDA via the delegate grant; contracts via this wrapper's
    ///      escrow ATA.
    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");

        bool fromIsContract = from.code.length > 0;
        bool toIsContract = to.code.length > 0;

        // Both ends escrow-held: ledger move only.
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

        // Only a fee-capable mint pays for the live-fee read.
        bool fee_armed = false;
        if (fee_capable) {
            (, , , uint16 feeBps, ) = SplCached.mint_info(mint_id);
            fee_armed = feeBps > 0;
        }
        uint256 before = fee_armed
            ? (toIsContract ? _wrapperOnChainBalance() : balanceOf(to))
            : 0;

        if (toIsContract) {
            _ensureWrapperAta();
        } else if (!_ataCreated[to]) {
            // Unknown recipient: probe once (overlay-aware) and remember the answer.
            try SplCached.account(to, mint_id) returns (ISplCached.Account memory) {
                _ataCreated[to] = true;
            } catch {
                _createAta(to);
            }
        }

        bool ok;
        bytes memory result;
        if (!fromIsContract) {
            // The wrapper must be `from`'s SPL delegate; a contract recipient is paid into this
            // wrapper's escrow ATA.
            address dest = toIsContract ? address(this) : to;
            (ok, result) = address(SplCached).call(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint256,bytes32)",
                    from, dest, value, mint_id
                )
            );
        } else {
            // `from`'s SPL is in this wrapper's own ATA; no delegate needed.
            (ok, result) = address(SplCached).call(
                abi.encodeWithSignature(
                    "transfer(address,uint256,bytes32)",
                    to, value, mint_id
                )
            );
        }
        require(ok, string(Convert.revert_msg(result)));

        // Measure the loss, not the gain: a self-transfer with an armed fee nets minus fee, so
        // `after - before` would underflow.
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

    /// @notice Pure EVM allowance; see `isEnabled` for the SPL-level grant.
    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) {
            revert ERC20InvalidSpender(address(0));
        }
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }
}
