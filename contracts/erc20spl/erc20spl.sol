// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {HelperProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {UserPda} from "../cpi/UserPda.sol";
import {AccountReader} from "../cpi/AccountReader.sol";
import {Convert} from "../convert.sol";

/// @notice Registry of EVM address to external-auth PDA, shared by the wrappers.
contract ERC20Users {
    mapping (address => bytes32) private users;

    /// @dev Registers `user`'s PDA, idempotently. Does not fund it.
    function ensure_user(address user) public returns (bytes32) {
        bytes32 existing_user = users[user];
        if (existing_user == bytes32(0)) {
            bytes32 new_user = RomeEVMAccount.get_payer(user);
            users[user] = new_user;
            return new_user;
        } else {
            return existing_user;
        }
    }

    /// @dev Reverts if `user` is not registered. Kept for existing callers.
    function get_user(address user) public view returns (bytes32) {
        bytes32 existing_user = users[user];
        require(existing_user != bytes32(0), "User does not exist");
        return existing_user;
    }
}

/// An armed transfer hook needs accounts these paths do not supply, so such a mint cannot be
/// wrapped here; a present but unarmed hook is accepted.
error ArmedTransferHookUnsupported(bytes32 mint, bytes32 hookProgram);

/// @dev Shared base of the fixed-account and hook-aware direct-CPI wrappers; never deployed itself.
abstract contract SPL_ERC20Base is IERC20, IERC20Metadata {
    bytes32 public constant system_program_id = 0x0000000000000000000000000000000000000000000000000000000000000000;
    // Associated Token program: ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
    bytes32 public constant associated_token_program_id = 0x8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859;

    address public immutable cpi_program;
    bytes32 public immutable mint_id;
    uint8 public immutable decimals;
    // TransferFeeConfig bit in `mint_info`'s extensions; fixed at mint creation, so only a
    // fee-capable wrapper reads the live fee per transfer.
    uint32 internal constant TRANSFER_FEE_CONFIG_EXTENSION_BIT = 1;
    bool public immutable fee_capable;

    string private _name;
    string private _symbol;
    // Not read by this contract; kept for the deploy ABI and SimpleActivator.
    ERC20Users internal _users;

    // Pure EVM allowance; separate from the user's one-time SPL delegate grant to this wrapper.
    mapping(address => mapping(address => uint256)) private _allowances;

    // A contract cannot approve, so its SPL sits in this wrapper's own ATA and is tracked here.
    // SPL sent to a not-yet-deployed CREATE2 address is not migrated when it deploys.
    mapping(address => uint256) private _escrow;

    // Once true, the ATA exists (never closed on Rome); false falls through to probe/create.
    mapping(address => bool) private _ataCreated;

    error ERC20InvalidApprover(address approver);
    error ERC20InvalidSpender(address spender);
    error ERC20InsufficientAllowance(address spender, uint256 currentAllowance, uint256 requiredAllowance);

    constructor(
        bytes32 _mint_id,
        address _cpi_program,
        string memory name_,
        string memory symbol_,
        ERC20Users users_,
        bool supports_armed_transfer_hook
    ) {
        // An armed hook needs accounts these paths do not supply, so admission refuses it (a
        // present but unarmed hook is accepted).
        (, uint8 mint_decimals, bytes32 hook_program, , uint32 extensions) = HelperProgram.mint_info(_mint_id);
        if (hook_program != bytes32(0) && !supports_armed_transfer_hook) {
            revert ArmedTransferHookUnsupported(_mint_id, hook_program);
        }

        cpi_program = _cpi_program;
        mint_id = _mint_id;
        decimals = mint_decimals;
        _name = name_;
        _symbol = symbol_;
        _users = users_;
        fee_capable = (extensions & (uint32(1) << TRANSFER_FEE_CONFIG_EXTENSION_BIT)) != 0;
    }

    /// @notice Creates the user's ATA (idempotent) and returns its address. `payer` is ignored;
    ///         the operator pays rent.
    function create_token_account(address user, bytes32 /* payer, unused */) public returns(bytes32) {
        _createAta(user);
        return HelperProgram.ata(user, mint_id);
    }

    /// @dev The one create site; sets the created-flag.
    function _createAta(address user) internal {
        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata(address,bytes32)",
                user, mint_id
            )
        );
        require(success, string(Convert.revert_msg(result)));
        _ataCreated[user] = true;
    }

    /// @dev Hot-path ATA guarantee: returns 0 when the flag is set; otherwise derives the ATA,
    ///      probes `lamportsOf`, creates only if missing, and sets the flag (ATAs never close).
    function _ensureAta(address user) internal returns (bytes32) {
        if (_ataCreated[user]) {
            return bytes32(0);
        }
        bytes32 ata = HelperProgram.ata(user, mint_id);
        if (AccountReader.lamportsOf(ata) != 0) {
            _ataCreated[user] = true;
        } else {
            _createAta(user);
        }
        return ata;
    }

    /// @notice Creates the user's ATA if missing; returns its address.
    function ensure_token_account(address user) public returns (bytes32) {
        bytes32 ata = _ensureAta(user);
        return ata == bytes32(0) ? HelperProgram.ata(user, mint_id) : ata;
    }

    /// @notice The user's ATA address; never reverts, never creates it.
    function get_token_account(address user) public view returns (bytes32) {
        return HelperProgram.ata(user, mint_id);
    }

    function name() public view virtual returns (string memory) {
        return _name;
    }

    function symbol() public view virtual returns (string memory) {
        return _symbol;
    }

    function totalSupply() public view virtual returns (uint256) {
        // Views never revert (ERC-20).
        if (AccountReader.lamportsOf(mint_id) == 0) {
            return 0;
        }
        return uint256(AccountReader.readU64At(mint_id, 36));
    }

    function balanceOf(address account) public view virtual returns (uint256) {
        if (account.code.length > 0) {
            return _escrow[account];
        }
        return uint256(HelperProgram.user_balance(account, mint_id));
    }

    function transfer(address to, uint256 value) public virtual returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function _transfer(
        address from,
        address to,
        uint256 value
    ) internal virtual returns (bool) {
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");

        // EOAs move SPL under their PDA via the delegate grant; contracts via the escrow ATA.
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

        // A transfer-fee mint credits less than requested and `mint_info` omits maximum_fee, so
        // measure the balance change; only fee-capable mints pay for the live-fee read.
        bool fee_armed = false;
        if (fee_capable) {
            (, , , uint16 feeBps, ) = HelperProgram.mint_info(mint_id);
            fee_armed = feeBps > 0;
        }
        uint256 before = fee_armed
            ? (toIsContract ? uint256(HelperProgram.user_balance(address(this), mint_id)) : balanceOf(to))
            : 0;

        if (toIsContract) {
            _ensureWrapperAta();
        } else {
            // Create the recipient ATA on first transfer so sends to a fresh address do not revert.
            _ensureAta(to);
        }

        bool success;
        bytes memory result;
        if (!fromIsContract) {
            // The wrapper must be `from`'s SPL delegate; a contract recipient is paid into this
            // wrapper's escrow ATA.
            address dest = toIsContract ? address(this) : to;
            (success, result) = address(HelperProgram).call(
                abi.encodeWithSignature(
                    "transfer_spl(address,address,uint64,bytes32)",
                    from, dest, uint64(value), mint_id
                )
            );
        } else {
            // `from`'s SPL is in this wrapper's own ATA; no delegate needed.
            (success, result) = address(HelperProgram).call(
                abi.encodeWithSignature(
                    "transfer_spl(address,uint64,bytes32)",
                    to, uint64(value), mint_id
                )
            );
        }

        require (success, string(Convert.revert_msg(result)));

        // Self-transfer with an armed fee nets minus fee: measure the loss to avoid an underflow.
        uint256 delivered = value;
        if (fee_armed) {
            uint256 now_ = toIsContract
                ? uint256(HelperProgram.user_balance(address(this), mint_id))
                : balanceOf(to);
            delivered = to == from ? value - (before - now_) : now_ - before;
        }

        // `to` gains the post-fee amount, or the ledger would exceed the escrow ATA.
        if (fromIsContract) {
            _escrow[from] -= value;
        }
        if (toIsContract) {
            _escrow[to] += delivered;
        }

        emit Transfer(from, to, delivered);
        return true;
    }

    /// @dev Implemented by SPL_ERC20 (escrow ATA); the hooked wrapper never calls `_transfer`.
    function _ensureWrapperAta() internal virtual returns (bytes32);

    function allowance(address owner, address spender) public view virtual returns (uint256) {
        return _allowances[owner][spender];
    }

    /// @notice True when `user` has granted this wrapper the SPL delegate it needs.
    function isEnabled(address user) public view returns (bool) {
        return HelperProgram.allowance_of(user, address(this), mint_id) > 0;
    }

    function approve(address spender, uint256 value) public virtual returns (bool) {
        if (spender == address(0)) {
            revert ERC20InvalidSpender(address(0));
        }
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public virtual returns (bool) {
        address spender = msg.sender;
        _spendAllowance(from, spender, value);
        return _transfer(from, to, value);
    }

    /// @dev OZ semantics (max is never decremented). This is the only per-spender check: SPL sees
    ///      only this wrapper as signer.
    function _spendAllowance(address owner, address spender, uint256 value) internal {
        uint256 currentAllowance = _allowances[owner][spender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < value) {
                revert ERC20InsufficientAllowance(spender, currentAllowance, value);
            }
            unchecked {
                _allowances[owner][spender] = currentAllowance - value;
            }
        }
    }

    /// @notice Sends the caller's SPL to any Solana wallet, creating the recipient ATA if missing.
    /// @param solana_recipient Receiving wallet pubkey on Solana.
    /// @param value Amount in this wrapper's smallest unit (must fit u64).
    function bridgeOutToSolana(bytes32 solana_recipient, uint256 value)
        public
        virtual
        returns (bool)
    {
        require(value <= type(uint64).max, "Bridge amount exceeds uint64");
        require(solana_recipient != bytes32(0), "Solana recipient cannot be zero");

        bytes32 to_ata = UserPda.ataForKey(solana_recipient, mint_id);

        (bool ataOk, bytes memory ataResult) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata_for_key(bytes32,bytes32)",
                solana_recipient, mint_id
            )
        );
        require(ataOk, string(Convert.revert_msg(ataResult)));

        bytes32 src_ata = HelperProgram.ata(msg.sender, mint_id);
        (bool xferOk, bytes memory xferResult) = address(HelperProgram).call(
            abi.encodeWithSignature(
                "transfer_spl(bytes32,bytes32,uint64,bytes32)",
                src_ata, to_ata, uint64(value), mint_id
            )
        );
        require(xferOk, string(Convert.revert_msg(xferResult)));

        emit BridgedOutToSolana(msg.sender, solana_recipient, mint_id, value);
        return true;
    }

    /// @notice Emitted when SPL leaves Rome.
    event BridgedOutToSolana(
        address indexed from,
        bytes32 indexed solana_recipient,
        bytes32 indexed mint_id,
        uint256 value
    );

    /// @notice Creates a recipient's ATA without transferring (`bridgeOutToSolana` also does it
    ///         inline).
    /// @param solana_recipient Wallet pubkey on Solana that will own the ATA.
    /// @return The recipient's ATA address.
    function ensureRecipientAta(bytes32 solana_recipient)
        public
        virtual
        returns (bytes32)
    {
        require(solana_recipient != bytes32(0), "Solana recipient cannot be zero");

        bytes32 to_ata = UserPda.ataForKey(solana_recipient, mint_id);

        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata_for_key(bytes32,bytes32)",
                solana_recipient, mint_id
            )
        );
        require(success, string(Convert.revert_msg(result)));

        emit RecipientAtaEnsured(msg.sender, solana_recipient, mint_id, to_ata);
        return to_ata;
    }

    /// @notice Emitted by every `ensureRecipientAta` call, whether or not the ATA already existed.
    event RecipientAtaEnsured(
        address indexed funder_evm,
        bytes32 indexed solana_recipient,
        bytes32 indexed mint_id,
        bytes32 ata
    );
}

/// @title SPL_ERC20
/// @notice Fixed-account direct-CPI wrapper for mints without an armed transfer hook.
contract SPL_ERC20 is SPL_ERC20Base {
    bytes32 public immutable escrow_ata;

    bool private _escrowAtaCreated;

    constructor(
        bytes32 _mint_id,
        address _cpi_program,
        string memory name_,
        string memory symbol_,
        ERC20Users users_
    ) SPL_ERC20Base(_mint_id, _cpi_program, name_, symbol_, users_, false) {
        escrow_ata = HelperProgram.ata(address(this), _mint_id);
    }

    /// @dev Creates this wrapper's escrow ATA at most once.
    function _ensureWrapperAta() internal virtual override returns (bytes32) {
        if (_escrowAtaCreated) {
            return escrow_ata;
        }
        if (AccountReader.lamportsOf(escrow_ata) != 0) {
            _escrowAtaCreated = true;
            return escrow_ata;
        }
        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata(address,bytes32)",
                address(this), mint_id
            )
        );
        require(success, string(Convert.revert_msg(result)));
        _escrowAtaCreated = true;
        return escrow_ata;
    }
}
