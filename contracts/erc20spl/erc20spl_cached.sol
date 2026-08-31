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
        try SplCached.account(account, mint_id) returns (ISplCached.Account memory acc) {
            return uint256(acc.amount);
        } catch {
            return 0;
        }
    }

    /// @notice ERC-20: allowance returns 0 (not revert) for any (owner, spender).
    ///         Same overlay-aware pattern as `balanceOf` — try/catch on
    ///         `SplCached.account` instead of a legacy lamports probe.
    ///         Reason: a protocol that calls `approve` then reads
    ///         `allowance` within the same tx would see stale (0) data
    ///         from the legacy probe, since `SplCached.approve` writes
    ///         to overlay but the legacy lamports read is on-chain-only.
    ///         Saturates uint64::max → uint256::max for wallet "infinite approval".
    function allowance(address owner, address spender) external view returns (uint256) {
        try SplCached.account(owner, mint_id) returns (ISplCached.Account memory acc) {
            bytes32 spenderPda = HelperProgram.pda(spender);
            if (acc.delegate != spenderPda) return 0;
            return acc.delegated_amount == type(uint64).max
                ? type(uint256).max
                : uint256(acc.delegated_amount);
        } catch {
            return 0;
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
        return _transfer(from, to, value);
    }

    /// @notice Internal transfer dispatcher — selects sender path or
    ///         delegate path based on `from == msg.sender`. Both paths
    ///         go through SplCached, locking the tx to the cache track.
    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(value <= type(uint64).max, "Transfer amount exceeds uint64");
        _users.ensure_user(msg.sender);

        // Read the destination before the transfer only when a fee is armed;
        // an unarmed or absent fee credits exactly `value`, so the common path
        // pays nothing for this.
        (, , , uint16 feeBps, ) = SplCached.mint_info(mint_id);
        bool fee_armed = feeBps > 0;
        uint256 before = fee_armed ? balanceOf(to) : 0;
        // Gate recipient ATA-create on existence (mirror approve #216): on the
        // common transfer-to-existing-holder path, skip the idempotent
        // AssociatedSplCached.create_ata round-trip. Overlay-aware via
        // try SplCached.account so an ATA created earlier this tx counts.
        try SplCached.account(to, mint_id) returns (ISplCached.Account memory) {
            // recipient ATA exists (overlay or on-chain) — skip create
        } catch {
            ensure_token_account(to);
        }

        bool ok;
        bytes memory result;
        if (from == msg.sender) {
            // Sender path — rome-evm's DELEGATECALL identity gate refuses
            // the owner-signs-as-caller precompile path (Halborn #511):
            // under DELEGATECALL, `caller` is borrowed from the outer
            // frame, so an owner-authenticated sign is a forgeable
            // authority. Instead: a DIRECT call (not delegatecall) into
            // the delegate selector, signing as external_auth(this) —
            // which is only ever this wrapper's own identity, never an
            // upstream caller's. Requires the caller to have pre-approved
            // this wrapper as delegate (`approve(address(this), value)`,
            // or the SDK's one-time direct-precompile approve step that
            // folds into the same tx as the first transfer).
            (ok, result) = address(SplCached).call(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint256,bytes32)",
                    from,
                    to,
                    value,
                    mint_id
                )
            );
        } else {
            // Delegate path — caller-PDA is the SPL delegate set by a
            // prior approve(). Cache SplCached.transferFrom at
            // 0x401e3367. SPL Token accepts PDA as ATA owner OR
            // delegated-amount delegate.
            (ok, result) = address(SplCached).delegatecall(
                abi.encodeWithSignature(
                    "transferFrom(address,address,uint256,bytes32)",
                    from,
                    to,
                    value,
                    mint_id
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
            uint256 now_ = balanceOf(to);
            delivered = to == from ? value - (before - now_) : now_ - before;
        }
        emit Transfer(from, to, delivered);
        return true;
    }

    /// @notice ERC-20: approve succeeds for any caller regardless of balance.
    ///         SPL approve_checked writes the delegate fields on the owner ATA,
    ///         so the ATA must exist. Auto-create if missing; the existence
    ///         probe uses overlay-aware `SplCached.account` (try/catch) so
    ///         repeated approves in the same tx skip the redundant
    ///         ensure_token_account call. The previous legacy
    ///         `AccountReader.lamportsOf` probe read on-chain only — it
    ///         saw stale lamports for an ATA that was created earlier in
    ///         the same tx (overlay), so it would fire the idempotent
    ///         AssociatedSplCached.create_ata CPI every time → ~30K CU
    ///         per redundant call.
    ///         Saturates uint64::max → uint256::max for wallet "infinite approval".
    function approve(address spender, uint256 value) external returns (bool) {
        _users.ensure_user(msg.sender);
        try SplCached.account(msg.sender, mint_id) returns (ISplCached.Account memory) {
            // ATA exists in cache (overlay or on-chain) — skip create.
        } catch {
            ensure_token_account(msg.sender);
        }
        uint64 storedAmount = value > type(uint64).max
            ? type(uint64).max
            : uint64(value);
        // Direct call, not delegatecall (Halborn #511 — the rome-evm gate
        // refuses owner-signs-as-caller under DELEGATECALL). Owner
        // resolves to external_auth(this), so this sets a delegate on
        // the wrapper's OWN ATA, not the caller's — the functional
        // approve for a user's own tokens is the SDK's direct-precompile
        // call (spender=this wrapper), composed ahead of the first
        // transfer/bridge-out. Kept for IERC20 interface compatibility.
        (bool ok, bytes memory result) = address(SplCached).call(
            abi.encodeWithSignature(
                "approve(address,uint256,bytes32)",
                spender,
                storedAmount,
                mint_id
            )
        );
        require(ok, string(Convert.revert_msg(result)));
        uint256 emittedValue = storedAmount == type(uint64).max
            ? type(uint256).max
            : uint256(storedAmount);
        emit Approval(msg.sender, spender, emittedValue);
        return true;
    }

    /// @notice Caller-PDA signs as the on-chain mint authority. SPL
    ///         Token runtime enforces caller-PDA == mint authority.
    ///         Recipient ATA auto-created via ensure_token_account.
    function mint_to(address to, uint256 value) external returns (bool) {
        require(value <= type(uint64).max, "Mint amount exceeds uint64");
        _users.ensure_user(msg.sender);
        // Mirror _transfer's overlay-aware ATA gate. Minting to an existing
        // holder should not spend an idempotent create-ATA invoke; an ATA
        // created earlier in this cached transaction is visible here too.
        try SplCached.account(to, mint_id) returns (ISplCached.Account memory) {
            // Recipient ATA already exists in the cache/on-chain state.
        } catch {
            ensure_token_account(to);
        }
        // Direct call, not delegatecall (Halborn #511 [H2]). Mint
        // authority resolves to external_auth(this) — SPL Token enforces
        // that this wrapper's own PDA is the on-chain mint authority.
        (bool ok, bytes memory result) = address(SplCached).call(
            abi.encodeWithSignature(
                "mint(address,uint256,bytes32)",
                to,
                value,
                mint_id
            )
        );
        require(ok, string(Convert.revert_msg(result)));
        emit Transfer(address(0), to, value);
        return true;
    }
}
