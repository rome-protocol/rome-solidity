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
/// @notice Cache-based ERC20 wrapper around an SPL mint. Replaces the
///         CPI-based SPL_ERC20 on devnet. All mutations dispatch through
///         the cache-based precompile family (SplCached at 0xff..05,
///         AssociatedSplCached at 0xff..06). Reads use whichever
///         precompile gives the cleanest answer per the CU preference
///         order in the migration spec:
///           1. EthCall                              — HelperProgram.ata
///           2. HelperProgram CrossStateEthCall      — user_balance, allowance_of
///           3. CpiProgram CrossStateEthCall         — account_lamports, account_u64_at
///
/// @dev    Per the the Rome EVM program one-track-per-contract HARD RULE,
///         this contract does NOT perform any CPI Invoke. Bridge methods
///         (bridgeOutToSolana, ensureRecipientAta) which require the
///         permanently-CPI-only create_ata_for_key are NOT exposed here
///         — they relocate to a separate sibling contract per follow-up
///         spec.
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

    // Post-the delegatecall gate (default-deny at the non-EVM dispatch boundary refuses a
    // DELEGATECALL into a mutating precompile selector that isn't exempt):
    // this wrapper can no longer move a user's SPL by borrowing the user's
    // own authority via delegatecall. EOA-side movement below is a direct
    // CALL to SplCached, which signs as external_auth(address(this)) — so
    // the wrapper must be the user's SPL delegate, set once by the user's
    // own EOA sending `approve_spl(wrapper, u64.max, mint)` to 0xff..09.
    // allowance/approve below are the EVM-side allowance this contract
    // tracks itself; they no longer touch the SPL-level grant at all.
    mapping(address => mapping(address => uint256)) private _allowances;

    // Contract-holder escrow (scope §6.2): a deployed pool/pool-like
    // contract can never call `approve`, so its SPL lives in this
    // wrapper's own ATA and its balance is tracked here instead of read
    // off-chain. balanceOf dispatches on `account.code.length`. Same
    // CREATE2-counterfactual note as erc20spl.sol: an address with no code
    // yet is treated as an EOA; funds sent to it pre-deploy are not
    // migrated into `_escrow` if it's later deployed to.
    mapping(address => uint256) private _escrow;

    constructor(
        bytes32 _mint_id,
        address _cpi_program,
        string memory name_,
        string memory symbol_,
        ERC20Users users_
    ) {
        // Read on this contract's own track: once a cached invoke has fired in a
        // transaction, verify_call refuses a legacy cross-state read. Same
        // selector, same answer. An armed hook is refused here too — the cached
        // track additionally cannot stage one at all, since the processor it runs
        // in-process would reach a real CPI.
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
    }

    function name() external view returns (string memory) {
        return _name;
    }

    function symbol() external view returns (string memory) {
        return _symbol;
    }

    // ─── Read views — CPI CrossStateEthCall + EthCall ─────────────────────

    /// @notice SPL Mint.supply (u64 LE at offset 36). Returns 0 when the
    ///         mint account is uninitialized so consumers that probe the
    ///         wrapper during chain bring-up don't revert (ERC-20 spec
    ///         invariant: views never revert).
    function totalSupply() external view returns (uint256) {
        if (AccountReader.lamportsOf(mint_id) == 0) {
            return 0;
        }
        return uint256(AccountReader.readU64At(mint_id, 36));
    }

    /// @notice ERC-20: balanceOf returns 0 (not revert) for any address.
    ///         Uses try/catch on `SplCached.account` instead of a legacy
    ///         `AccountReader.lamportsOf` short-circuit.
    ///
    ///         Why the change: legacy CpiProgram CrossStateEthCall reads
    ///         (e.g. `account_lamports`) hit on-chain state directly and
    ///         are NOT overlay-aware. Cached-track writes (SplCached.
    ///         transferFrom inside the same tx) update the `NonEvmState`
    ///         overlay; `CachedState::account` consults overlay first.
    ///         If `balanceOf` short-circuits on legacy lamports, the
    ///         AFTER-callback balance read inside V3 Pool.mint sees
    ///         stale 0 from on-chain, so the
    ///         `require(balance0Before + amount0 <= balance0())` check
    ///         reverts with 'M0' even though the cached transferFrom
    ///         succeeded.
    ///
    ///         Try/catch on SplCached.account is the overlay-aware
    ///         short-circuit: precompile reverts on missing ATA → catch
    ///         returns 0; precompile succeeds → returns amount from
    ///         whichever state (overlay if written, on-chain otherwise).
    ///
    ///         Discovered 2026-05-25 during Hadrian V3 create-pool
    ///         smoke (the Rome app). Cross-ref:
    ///         rome-uniswap-v3/contracts/UniswapV3Pool.sol:486-490.
    function balanceOf(address account) public view returns (uint256) {
        // Contract-holder escrow (§6.2): a contract's SPL sits in this
        // wrapper's own ATA, not `ata(external_auth(account))` — its
        // balance is the ledger, not an on-chain read.
        if (account.code.length > 0) {
            return _escrow[account];
        }
        try SplCached.account(account, mint_id) returns (ISplCached.Account memory acc) {
            return uint256(acc.amount);
        } catch {
            return 0;
        }
    }

    /// @notice ERC-20 allowance, post-the delegatecall gate: a plain EVM mapping, entirely
    ///         decoupled from the SPL-level delegate grant (see
    ///         `isEnabled`). A direct CALL from this wrapper can no longer
    ///         write the owner's SPL-level Approve — SPL Token would
    ///         reject it outright (the wrapper isn't the ATA owner).
    function allowance(address owner, address spender) external view returns (uint256) {
        return _allowances[owner][spender];
    }

    /// @notice Whether `user` has sent the one-time SPL-level delegate
    ///         grant (`approve_spl(wrapper, …, mint)` direct to 0xff..09)
    ///         this wrapper needs to move their SPL at all. Reads via the
    ///         cached-track `SplCached.account` (overlay-aware, stays on
    ///         this contract's track) rather than the legacy
    ///         `HelperProgram.allowance_of` — mixing tracks in one
    ///         contract is the one-track rule this file must not break.
    function isEnabled(address user) public view returns (bool) {
        try SplCached.account(user, mint_id) returns (ISplCached.Account memory acc) {
            return acc.delegate == HelperProgram.pda(address(this)) && acc.delegated_amount > 0;
        } catch {
            return false;
        }
    }

    /// @notice Pure EthCall derivation — `external_auth(user) + mint_id`
    ///         ATA pubkey. Never a track-locking event; never reverts.
    function get_token_account(address user) external view returns (bytes32) {
        return HelperProgram.ata(user, mint_id);
    }

    // ─── Mutating ERC-20 surface — all cache-based Invokes ────────────────

    /// @notice Idempotent ATA bootstrap. Drops the prior CpiProgram
    ///         account_lamports (legacy 0xff..08) probe that was used as
    ///         a CU optimization — AssociatedSplCached.create_ata is
    ///         idempotent on the Solana side, so calling it
    ///         unconditionally is safe semantically. Removing the probe
    ///         eliminates the last legacy-precompile READ from this
    ///         wrapper's hot path, making the wrapper fully cache-track
    ///         (so canonical UV2 pair can compose without verify_call
    ///         ordering issues).
    function ensure_token_account(address user) public returns (bytes32) {
        bytes32 ata = HelperProgram.ata(user, mint_id);
        (bool ok, bytes memory result) = address(AssociatedSplCached).delegatecall(
            abi.encodeWithSignature(
                "create_ata(address,bytes32)",
                user,
                mint_id
            )
        );
        require(ok, string(Convert.revert_msg(result)));
        return ata;
    }

    /// @notice Public ATA-create entry. Cache invoke; idempotent on
    ///         repeat. The ATA address returned via HelperProgram.ata
    ///         after the create — EthCall (pure compute) is exempt from
    ///         the verify_call gate, so it works even after the cache
    ///         mutation has fired this tx.
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

    /// @dev Ensures this wrapper's own SPL ATA exists — the escrow account
    /// that holds every contract holder's balance (§6.2). Per the one-track
    /// rule the create must stay AssociatedSplCached, not the Helper form.
    /// Overlay-aware existence check (SplCached.account), same pattern as
    /// ensure_token_account/approve above.
    function _ensureWrapperAta() internal returns (bytes32) {
        bytes32 wrapperAta = HelperProgram.ata(address(this), mint_id);
        try SplCached.account(address(this), mint_id) returns (ISplCached.Account memory) {
            return wrapperAta;
        } catch {
            (bool ok, bytes memory result) = address(AssociatedSplCached).delegatecall(
                abi.encodeWithSignature("create_ata(address,bytes32)", address(this), mint_id)
            );
            require(ok, string(Convert.revert_msg(result)));
            return wrapperAta;
        }
    }

    /// @dev Direct on-chain read of the wrapper's own ATA. Bypasses
    /// `balanceOf`'s contract branch, which would return
    /// `_escrow[address(this)]` — the wrong number for measuring what the
    /// escrow ATA itself actually received.
    function _wrapperOnChainBalance() internal view returns (uint256) {
        try SplCached.account(address(this), mint_id) returns (ISplCached.Account memory acc) {
            return uint256(acc.amount);
        } catch {
            return 0;
        }
    }

    /// @notice Internal transfer dispatcher. Post-the delegatecall gate, routing is by
    ///         whether an endpoint HOLDS SPL under a PDA it can sign for
    ///         (an EOA, via the wrapper acting as its delegate) or under
    ///         this wrapper's own escrow ATA (a contract, which can never
    ///         call `approve`) — not by who the caller is (mirrors
    ///         erc20spl.sol §4.1's `_transfer`). transfer/transferFrom
    ///         both land here identically.
    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");
        _users.ensure_user(msg.sender);

        bool fromIsContract = from.code.length > 0;
        bool toIsContract = to.code.length > 0;

        // contract -> contract: the SPL never leaves this wrapper's own
        // ATA — a pure EVM ledger move, no CPI, no transfer-fee to net.
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

        // Read the destination before the transfer only when a fee is armed;
        // an unarmed or absent fee credits exactly `value`, so the common path
        // pays nothing for this. Measured off whichever ATA actually receives
        // the SPL on-chain: the wrapper's own escrow ATA when `to` is a
        // contract, `to`'s own PDA-owned ATA otherwise.
        (, , , uint16 feeBps, ) = SplCached.mint_info(mint_id);
        bool fee_armed = feeBps > 0;
        uint256 before = fee_armed
            ? (toIsContract ? _wrapperOnChainBalance() : balanceOf(to))
            : 0;

        if (toIsContract) {
            // Contract recipient: ensure THIS wrapper's own escrow ATA
            // exists — the ATA that matters here is the wrapper's, not
            // `to`'s.
            _ensureWrapperAta();
        } else {
            // Gate recipient ATA-create on existence: on the common
            // transfer-to-existing-holder path, skip the idempotent
            // AssociatedSplCached.create_ata round-trip. Overlay-aware via
            // try SplCached.account so an ATA created earlier this tx counts.
            try SplCached.account(to, mint_id) returns (ISplCached.Account memory) {
                // recipient ATA exists (overlay or on-chain) — skip create
            } catch {
                ensure_token_account(to);
            }
        }

        bool ok;
        bytes memory result;
        if (!fromIsContract) {
            // `from` is an EOA: its SPL sits in `ata(external_auth(from))`.
            // Post-the delegatecall gate this wrapper can no longer sign as that PDA via
            // delegatecall — it must be `from`'s SPL delegate instead (a
            // one-time user-signed `approve_spl(wrapper, …)` to 0xff..09).
            // Direct CALL so SplCached signs as external_auth(address(this)).
            // `to` collapses to address(this) when the recipient is a
            // contract, landing the SPL in this wrapper's own escrow ATA
            // instead of a contract that could never approve it back out.
            address dest = toIsContract ? address(this) : to;
            (ok, result) = address(SplCached).call(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint256,bytes32)",
                    from, dest, value, mint_id
                )
            );
        } else {
            // `from` is a contract holder: its SPL already sits in this
            // wrapper's own ATA (credited on the way in). `transfer`
            // derives from_ata = ata(external_auth(context.caller)) —
            // under direct CALL that's the wrapper's own ATA, which it
            // owns outright. No delegate needed.
            (ok, result) = address(SplCached).call(
                abi.encodeWithSignature(
                    "transfer(address,uint256,bytes32)",
                    to, value, mint_id
                )
            );
        }
        require(ok, string(Convert.revert_msg(result)));

        // A transfer-fee mint credits the destination less than was requested,
        // and the fee is capped by maximum_fee — which mint_info deliberately
        // does not carry, because computing the fee here would duplicate SPL's
        // arithmetic and be wrong at the cap. So measure the delta instead of
        // computing it, and only pay for the extra reads when a fee is actually
        // armed: feeBps is a predicate, not an operand.
        // Self-transfer needs the other direction. Sending to yourself with an
        // armed fee debits `value` and credits `value - fee`, so the account nets
        // MINUS fee — `after - before` would underflow and revert, and ERC-20
        // self-transfer must not revert. Measuring the loss gives the delivered
        // amount in both directions.
        uint256 delivered = value;
        if (fee_armed) {
            uint256 now_ = toIsContract ? _wrapperOnChainBalance() : balanceOf(to);
            delivered = to == from ? value - (before - now_) : now_ - before;
        }

        // Ledger side-effects mirror what actually moved on-chain.
        if (fromIsContract) {
            _escrow[from] -= value;
        }
        if (toIsContract) {
            _escrow[to] += delivered;
        }

        emit Transfer(from, to, delivered);
        return true;
    }

    /// @notice ERC-20 approve, post-the delegatecall gate: pure EVM storage, no SPL CPI at
    ///         all. The SPL-level grant this used to also write is now the
    ///         user's own one-time `approve_spl(wrapper, u64.max, mint)`
    ///         direct to 0xff..09, entirely decoupled (see `isEnabled`).
    ///         No u64 saturation sentinel: this is uint256 EVM storage,
    ///         not u64 SPL delegated_amount storage, so there's nothing to
    ///         saturate against.
    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) {
            revert ERC20InvalidSpender(address(0));
        }
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    // mint_to DELETED (the delegatecall gate change 5 / scope §6.1, cached track): a direct
    // CALL to SplCached.mint would sign as external_auth(address(this)),
    // which is not the on-chain mint authority. Minting is a creator/
    // operator act, not a user act — the creator EOA calls
    // SplCached.mint(address,uint256,bytes32) directly instead. ABI break:
    // `wrapper.mint_to(...)` no longer exists.
}
