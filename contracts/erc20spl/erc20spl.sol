// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";
import {AssociatedSplToken} from "../spl_token/associated_spl_token.sol";
import {ISystemProgram, ICrossProgramInvocation, CpiProgram, HelperProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {UserPda} from "../cpi/UserPda.sol";
import {AccountReader} from "../cpi/AccountReader.sol";
import {Convert} from "../convert.sol";

contract ERC20Users {
    mapping (address => bytes32) private users;

    /// @dev Idempotent PDA registration only — does NOT fund the PDA.
    ///      Only `SimpleActivator.activate()` funds it; most operations work
    ///      unfunded, only rent-payer flows (CCTP/Wormhole message accounts)
    ///      need activation first.
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

    /// @dev Reverts if `user` isn't registered. Kept for cross-contract
    ///      back-compat; new code should prefer `HelperProgram.pda` (direct
    ///      derivation, no revert).
    function get_user(address user) public view returns (bytes32) {
        bytes32 existing_user = users[user];
        require(existing_user != bytes32(0), "User does not exist");
        return existing_user;
    }
}

/// A mint whose transfer hook is armed cannot be wrapped: the hook requires
/// extra accounts that no transfer path in this wrapper supplies. Unarmed hooks
/// are inert and are accepted.
error ArmedTransferHookUnsupported(bytes32 mint, bytes32 hookProgram);

/// @dev Shared implementation for the fixed-account and hook-aware direct-CPI
/// wrappers. Concrete wrappers choose their admission policy in the base
/// constructor; callers must never deploy this abstract implementation.
abstract contract SPL_ERC20Base is IERC20, IERC20Metadata {
    // SystemProgram
    bytes32 public constant system_program_id = 0x0000000000000000000000000000000000000000000000000000000000000000;
    // ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
    bytes32 public constant associated_token_program_id = 0x8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859;

    address public immutable cpi_program;
    bytes32 public immutable mint_id;
    uint8 public immutable decimals;

    string private _name;
    string private _symbol;
    ERC20Users internal _users;

    // A direct CALL signs as external_auth(address(this)), not the user's own
    // authority, so the wrapper must be the user's one-time SPL delegate
    // (`approve_spl(wrapper, max, mint)` sent by the user). This mapping is a
    // pure EVM allowance, decoupled from that SPL-level grant.
    mapping(address => mapping(address => uint256)) private _allowances;

    // A contract can never call `approve`, so its SPL lives in this wrapper's
    // own ATA and is tracked here (dispatch: `account.code.length`). SPL sent
    // to a not-yet-deployed CREATE2 address lands in that address's own ATA
    // (treated as an EOA), not `_escrow`, even after it's later deployed to.
    mapping(address => uint256) private _escrow;

    // Once true, ATA existence is assumed forever (ATAs are never closed on
    // Rome). False always falls through to the same probe/create path, so an
    // ATA created outside this wrapper is still detected on first sight.
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
        // mint_info also reports whether a transfer hook is ARMED; an armed
        // hook needs accounts this wrapper's transfer paths don't supply, so
        // admission refuses armed (not merely present) hooks.
        (, uint8 mint_decimals, bytes32 hook_program, ,) = HelperProgram.mint_info(_mint_id);
        if (hook_program != bytes32(0) && !supports_armed_transfer_hook) {
            revert ArmedTransferHookUnsupported(_mint_id, hook_program);
        }

        cpi_program = _cpi_program;
        mint_id = _mint_id;
        decimals = mint_decimals;
        _name = name_;
        _symbol = symbol_;
        _users = users_;
    }

    /**
     * Helper function to create an associated token account for a user if it doesn't exist, and return the associated token account address.
     * @param user EVM address of the user for whom to create the associated token account
     * @return associated_account_address The address of the associated token account created or existing for the user
     */
    function create_token_account(address user, bytes32 /* payer, unused */) public returns(bytes32) {
        _users.ensure_user(user);

        // The operator pays ATA rent (reimbursed via gas accounting); `payer`
        // is ignored but kept in the signature for caller back-compat.
        (bool success, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata(address,bytes32)",
                user, mint_id
            )
        );
        require(success, string(Convert.revert_msg(result)));

        return HelperProgram.ata(user, mint_id);
    }

    /**
     * Checks if the user has an associated token account, and if not, creates one. Returns the associated token account address.
     * @param user EVM address of the user for whom to ensure the associated token account exists
     * @return associated_account_address The address of the associated token account created or existing for the user
     */
    function ensure_token_account(address user) public returns (bytes32) {
        if (_ataCreated[user]) {
            return HelperProgram.ata(user, mint_id);
        }

        // Skip the create CPI when the ATA is already initialized on Solana
        // — without this, every transfer would pay 2 CPIs, and pair.burn's
        // 2 outbound transfers would exceed Rome's per-tx CPI budget.
        bytes32 ata = HelperProgram.ata(user, mint_id);
        uint64 lamports = AccountReader.lamportsOf(ata);
        if (lamports != 0) {
            _ataCreated[user] = true;
            return ata;
        }

        bytes32 payer = _users.ensure_user(msg.sender);
        bytes32 result = create_token_account(user, payer);
        _ataCreated[user] = true;
        return result;
    }

    /// @dev Same ATA that bridge-in deposits land in and balanceOf reads.
    ///      Never reverts, and never creates it — call
    ///      `ensure_token_account(user)` for that.
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
        // SPL Mint layout: supply is a u64 LE at offset 36.
        // Views must never revert (ERC-20 spec) — return 0 for an
        // uninitialized mint instead of reverting on the out-of-bounds read.
        if (AccountReader.lamportsOf(mint_id) == 0) {
            return 0;
        }
        return uint256(AccountReader.readU64At(mint_id, 36));
    }

    function balanceOf(address account) public view virtual returns (uint256) {
        // A contract can't call `approve`; its balance is the escrow ledger,
        // not an on-chain read.
        if (account.code.length > 0) {
            return _escrow[account];
        }
        // Reads SPL TokenAccount.amount directly; returns 0 if the ATA
        // doesn't exist.
        return uint256(HelperProgram.user_balance(account, mint_id));
    }

    function transfer(address to, uint256 value) public virtual returns (bool) {
        return _transfer(_users.ensure_user(msg.sender), msg.sender, to, value);
    }

    /// @dev `user` is unused: the precompile derives the signer from
    ///      context.caller itself. Callers still compute it for the
    ///      `ensure_user` mapping side-effect.
    function _transfer(
        bytes32 user,
        address from,
        address to,
        uint256 value
    ) internal virtual returns (bool) {
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");
        user;

        // Route by whether an endpoint holds SPL under a signable PDA (EOA,
        // via the wrapper's delegate grant) or the wrapper's own escrow ATA
        // (contract, which can never call `approve`) — not by caller identity.
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

        // A transfer-fee mint credits less than requested; mint_info omits
        // maximum_fee (computing the fee here would duplicate SPL's
        // arithmetic and be wrong at the cap), so measure the delta instead,
        // and only pay for it when a fee is actually armed.
        (, , , uint16 feeBps, ) = HelperProgram.mint_info(mint_id);
        bool fee_armed = feeBps > 0;
        // Whichever ATA actually receives the SPL on-chain: the wrapper's
        // own when `to` is a contract, `to`'s own otherwise.
        uint256 before = fee_armed
            ? (toIsContract ? uint256(HelperProgram.user_balance(address(this), mint_id)) : balanceOf(to))
            : 0;

        if (toIsContract) {
            // The ATA that matters here is the wrapper's own, not `to`'s.
            _ensureWrapperAta();
        } else {
            // Auto-create on first transfer — without it, sending to a fresh
            // address reverts and MetaMask's simulation greys out Send.
            ensure_token_account(to);
        }

        bool success;
        bytes memory result;
        if (!fromIsContract) {
            // `from`'s SPL sits in `ata(external_auth(from))`; direct CALL
            // signs as external_auth(address(this)), so the wrapper must be
            // `from`'s SPL delegate. `to` collapses to address(this) when
            // the recipient is a contract (lands in this wrapper's escrow).
            address dest = toIsContract ? address(this) : to;
            (success, result) = address(HelperProgram).call(
                abi.encodeWithSignature(
                    "transfer_spl(address,address,uint64,bytes32)",
                    from, dest, uint64(value), mint_id
                )
            );
        } else {
            // `from`'s SPL already sits in this wrapper's own ATA; the
            // 3-arg overload derives src_ata from context.caller, which
            // under direct CALL is the wrapper itself. No delegate needed.
            (success, result) = address(HelperProgram).call(
                abi.encodeWithSignature(
                    "transfer_spl(address,uint64,bytes32)",
                    to, uint64(value), mint_id
                )
            );
        }

        require (success, string(Convert.revert_msg(result)));

        // Self-transfer needs the other direction. Sending to yourself with an
        // armed fee debits `value` and credits `value - fee`, so the account nets
        // MINUS fee — `after - before` would underflow and revert, and ERC-20
        // self-transfer must not revert. Measuring the loss gives the delivered
        // amount in both directions.
        uint256 delivered = value;
        if (fee_armed) {
            uint256 now_ = toIsContract
                ? uint256(HelperProgram.user_balance(address(this), mint_id))
                : balanceOf(to);
            delivered = to == from ? value - (before - now_) : now_ - before;
        }

        // `to` gains `delivered` (post-fee), never the raw request, or the
        // ledger sum would exceed the wrapper's real escrow-ATA balance.
        if (fromIsContract) {
            _escrow[from] -= value;
        }
        if (toIsContract) {
            _escrow[to] += delivered;
        }

        emit Transfer(from, to, delivered);
        return true;
    }

    /// @dev Abstract so `_transfer` (shared here) has one call site to reach
    ///      regardless of which concrete wrapper is compiled in. `SPL_ERC20`
    ///      (below) escrows and implements it; `SPL_ERC20_Token2022Hooked`
    ///      never reaches `_transfer` and its override is a dead-code stub.
    function _ensureWrapperAta() internal virtual returns (bytes32);

    function allowance(address owner, address spender) public view virtual returns (uint256) {
        // uint256 EVM storage, not u64 SPL delegated_amount — no saturation
        // sentinel needed.
        return _allowances[owner][spender];
    }

    /// @notice Whether `user` has sent the one-time SPL-level delegate grant
    ///         this wrapper needs to move their SPL at all. Callers use this
    ///         to decide whether to prompt for the grant before the first
    ///         transfer.
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
        return _transfer(_users.ensure_user(spender), from, to, value);
    }

    /// @dev Matches OZ's infinite-approval semantics (`type(uint256).max` is
    ///      never decremented). This EVM-side check is the *only*
    ///      per-spender access control — a direct CALL always signs as
    ///      external_auth(address(this)), so SPL itself no longer
    ///      distinguishes which caller invoked it.
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

    /// @notice Sends this wrapper's underlying SPL from the caller's
    /// PDA-owned ATA to an arbitrary Solana wallet — no Rome account needed
    /// on the receiving end. Idempotently creates the recipient's ATA first
    /// if missing (same UX as Phantom's "send to fresh address").
    /// @param solana_recipient Receiving wallet pubkey on Solana.
    /// @param value Amount in this wrapper's smallest unit (must fit u64).
    /// @return success Always returns true on success; reverts otherwise.
    function bridgeOutToSolana(bytes32 solana_recipient, uint256 value)
        public
        virtual
        returns (bool)
    {
        require(value <= type(uint64).max, "Bridge amount exceeds uint64");
        require(solana_recipient != bytes32(0), "Solana recipient cannot be zero");

        // `solana_recipient` is a raw pubkey, not an EVM address —
        // `UserPda.ataForKey` resolves the token program from the mint so
        // the address matches whatever `create_ata_for_key` will create.
        bytes32 to_ata = UserPda.ataForKey(solana_recipient, mint_id);

        // Idempotent recipient-ATA create; operator pays rent, reimbursed
        // via Rome's gas accounting. `ensure_user` is preserved because
        // later bridge-out rails still need the caller registered with a
        // PDA reserve for their message-account rent.
        _users.ensure_user(msg.sender);
        (bool ataOk, bytes memory ataResult) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata_for_key(bytes32,bytes32)",
                solana_recipient, mint_id
            )
        );
        require(ataOk, string(Convert.revert_msg(ataResult)));

        // Direct CALL signs as external_auth(address(this)); the caller must
        // already be the wrapper's delegate (same as transfer/transferFrom).
        // `src_ata` is explicit since the recipient is a raw pubkey, not an
        // EVM address the address-keyed overload could derive it from.
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

    /// @notice Canonical "left Rome" signal for indexers, paired with the
    ///         on-chain Solana SPL transfer for the round-trip.
    event BridgedOutToSolana(
        address indexed from,
        bytes32 indexed solana_recipient,
        bytes32 indexed mint_id,
        uint256 value
    );

    /// @notice Idempotently pre-warms a recipient's ATA without transferring
    /// tokens. `bridgeOutToSolana` already creates it inline, so callers no
    /// longer need to preflight — kept for callers that want to warm an ATA
    /// on its own.
    /// @param solana_recipient Wallet pubkey on Solana that will own the ATA.
    /// @return The recipient's ATA address.
    function ensureRecipientAta(bytes32 solana_recipient)
        public
        virtual
        returns (bytes32)
    {
        require(solana_recipient != bytes32(0), "Solana recipient cannot be zero");

        _users.ensure_user(msg.sender);

        // create_ata_for_key returns nothing; the address is deterministic
        // from (wallet, mint, spl_program), with the token program resolved
        // from the mint rather than assumed.
        bytes32 to_ata = UserPda.ataForKey(solana_recipient, mint_id);

        // Operator pays rent, reimbursed via Rome's gas accounting.
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

    /// @notice For off-chain tracking of which wallets have a sponsored ATA
    ///         on which mint, so subsequent bridges can skip the create step.
    event RecipientAtaEnsured(
        address indexed funder_evm,
        bytes32 indexed solana_recipient,
        bytes32 indexed mint_id,
        bytes32 ata
    );

    // mint_to removed: a direct CALL can never be the mint authority
    // (ERC20SPLFactory sets it to HelperProgram.pda(creator)). The creator
    // mints via `mint_spl(address,uint64,bytes32)` sent directly to 0xff..09.
}

/// @title SPL_ERC20
/// @notice Fixed-account direct-CPI wrapper for legacy SPL and Token-2022
///         mints that do not have an armed Transfer Hook.
/// @dev Its constructor deliberately retains the armed-hook safety gate. The
///      hook-aware sibling is SPL_ERC20_Token2022Hooked.
contract SPL_ERC20 is SPL_ERC20Base {
    // Fixed for the contract's life — derived once here instead of
    // re-deriving via HelperProgram.ata on every contract-destined transfer.
    bytes32 public immutable escrow_ata;

    // Same monotone-existence argument as `_ataCreated` above.
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

    /// @dev Ensures this wrapper's own escrow ATA exists; runs the
    ///      existence probe at most once per instance.
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
