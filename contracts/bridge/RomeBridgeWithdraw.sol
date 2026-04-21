// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {SPL_ERC20} from "../erc20spl/erc20spl.sol";
import {CCTPLib} from "./ICCTP.sol";
import {WormholeTokenBridgeLib} from "./IWormholeTokenBridge.sol";
import {ICrossProgramInvocation, CpiProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {Convert} from "../convert.sol";
import {RomeBridgeEvents} from "./RomeBridgeEvents.sol";
import {SplTokenLib} from "../spl_token/spl_token.sol";


/// @title RomeBridgeWithdraw
/// @notice Accepts rToken input on Rome EVM, emits outbound CCTP or Wormhole
///         message via CPI signed as the user's Rome-derived PDA.
/// @dev CCTP path:     burnUSDC → depositForBurn CPI (path=0)
///      Wormhole path: burnETH  → transfer_tokens CPI  (path=1)
///
///      All Solana program IDs, sysvars, and PDAs are supplied at construction
///      from the deploy script. No pubkeys are hardcoded in this contract —
///      it is fully network-agnostic.
contract RomeBridgeWithdraw is ERC2771Context, RomeBridgeEvents {
    SPL_ERC20 public immutable usdcWrapper;
    SPL_ERC20 public immutable wethWrapper;
    bytes32 public immutable usdcMint;
    bytes32 public immutable wethMint;

    // -------------------------------------------------------------------------
    // CCTP Solana-side immutables (set at construction from deploy script)
    // -------------------------------------------------------------------------
    bytes32 public immutable cctpTokenMessengerProgram;
    bytes32 public immutable cctpMessageTransmitterProgram;
    bytes32 public immutable cctpSplTokenProgram;
    bytes32 public immutable cctpSystemProgram;
    bytes32 public immutable cctpMessageTransmitterConfig;
    bytes32 public immutable cctpTokenMessengerConfig;
    bytes32 public immutable cctpRemoteTokenMessenger;
    bytes32 public immutable cctpTokenMinter;
    bytes32 public immutable cctpLocalTokenUsdc;
    bytes32 public immutable cctpSenderAuthorityPda;
    bytes32 public immutable cctpEventAuthority;

    // -------------------------------------------------------------------------
    // Wormhole Solana-side immutables (set at construction from deploy script)
    // -------------------------------------------------------------------------
    bytes32 public immutable wormholeTokenBridgeProgram;
    bytes32 public immutable wormholeCoreProgram;
    bytes32 public immutable whSplTokenProgram;
    bytes32 public immutable whSystemProgram;
    bytes32 public immutable whClockSysvar;
    bytes32 public immutable whRentSysvar;
    bytes32 public immutable wormholeConfig;
    bytes32 public immutable wormholeCustody;
    bytes32 public immutable wormholeAuthoritySigner;
    bytes32 public immutable wormholeCustodySigner;
    bytes32 public immutable wormholeBridgeConfig;
    bytes32 public immutable wormholeFeeCollector;
    bytes32 public immutable wormholeEmitter;
    bytes32 public immutable wormholeSequence;
    bytes32 public immutable wormholeWrappedMeta;

    // -------------------------------------------------------------------------
    // Per-user nonce for transient message PDAs
    // -------------------------------------------------------------------------

    /// @notice Per-user burn counter used to derive unique message PDAs per tx.
    /// @dev We can't use block.number in the salt — on Rome EVM, block.number
    ///      returns the Solana slot (rome-evm-private/program/src/state/handler.rs
    ///      block_number() → self.slot), which changes between eth_call
    ///      simulation and on-chain execution. That divergence causes the
    ///      emulator to pass one messageSentEventData PDA and the on-chain
    ///      program to look up a different one → AccountNotFound. A user-scoped
    ///      monotonic counter is stable across the emulation/execution boundary
    ///      within the same tx and unique across txs.
    mapping(address => uint64) public burnNonce;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------
    error AmountExceedsUint64(uint256 amount);
    error InsufficientBalance(address user, uint256 requested, uint256 available);
    error CpiFailed(bytes reason);

    // -------------------------------------------------------------------------
    // Constructor params structs (avoids stack-too-deep with many constructor args)
    // -------------------------------------------------------------------------

    /// @notice CCTP-path Solana accounts. Includes all program IDs and PDAs needed
    ///         for the deposit_for_burn CPI. All fields come from the deploy script.
    struct CctpParams {
        /// @dev CCTP Token Messenger Minter Solana program ID
        ///      (CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3)
        bytes32 tokenMessengerProgram;
        /// @dev CCTP Message Transmitter Solana program ID
        ///      (CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd)
        bytes32 messageTransmitterProgram;
        /// @dev SPL Token program ID (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
        bytes32 splTokenProgram;
        /// @dev Solana System Program (11111111111111111111111111111111 → zero bytes)
        bytes32 systemProgram;
        // PDAs — derived per-deployment in Phase 1.5
        bytes32 messageTransmitterConfig;
        bytes32 tokenMessengerConfig;
        bytes32 remoteTokenMessenger;
        bytes32 tokenMinter;
        bytes32 localTokenUsdc;
        /// @dev ["sender_authority"] PDA under Token Messenger Minter program
        bytes32 senderAuthorityPda;
        bytes32 eventAuthority;
    }

    /// @notice Wormhole-path Solana accounts. Includes all program IDs, sysvars, and
    ///         PDAs needed for the transfer_tokens CPI. All fields come from the deploy script.
    struct WormholeParams {
        /// @dev Wormhole Token Bridge program ID (wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb)
        bytes32 tokenBridgeProgram;
        /// @dev Wormhole Core Bridge program ID (worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth)
        bytes32 coreProgram;
        /// @dev SPL Token program ID (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
        bytes32 splTokenProgram;
        /// @dev Solana System Program (11111111111111111111111111111111 → zero bytes)
        bytes32 systemProgram;
        /// @dev Clock sysvar (SysvarC1ock11111111111111111111111111111111)
        bytes32 clockSysvar;
        /// @dev Rent sysvar (SysvarRent111111111111111111111111111111111)
        bytes32 rentSysvar;
        // PDAs — derived per-deployment in Phase 1.5
        bytes32 config;
        bytes32 custody;          // kept for back-compat; not used by TransferWrapped path
        bytes32 authoritySigner;
        bytes32 custodySigner;    // kept for back-compat; not used by TransferWrapped path
        bytes32 bridgeConfig;
        bytes32 feeCollector;
        bytes32 emitter;
        bytes32 sequence;
        bytes32 wrappedMeta;      // NEW: [b"meta", wethMint] PDA under Token Bridge
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(
        address forwarder,
        SPL_ERC20 _usdc,
        SPL_ERC20 _weth,
        CctpParams memory cctp,
        WormholeParams memory wh
    ) ERC2771Context(forwarder) {
        usdcWrapper = _usdc;
        wethWrapper = _weth;
        usdcMint = _usdc.mint_id();
        wethMint = _weth.mint_id();
        // CCTP
        cctpTokenMessengerProgram     = cctp.tokenMessengerProgram;
        cctpMessageTransmitterProgram = cctp.messageTransmitterProgram;
        cctpSplTokenProgram           = cctp.splTokenProgram;
        cctpSystemProgram             = cctp.systemProgram;
        cctpMessageTransmitterConfig  = cctp.messageTransmitterConfig;
        cctpTokenMessengerConfig      = cctp.tokenMessengerConfig;
        cctpRemoteTokenMessenger      = cctp.remoteTokenMessenger;
        cctpTokenMinter               = cctp.tokenMinter;
        cctpLocalTokenUsdc            = cctp.localTokenUsdc;
        cctpSenderAuthorityPda        = cctp.senderAuthorityPda;
        cctpEventAuthority            = cctp.eventAuthority;
        // Wormhole
        wormholeTokenBridgeProgram = wh.tokenBridgeProgram;
        wormholeCoreProgram        = wh.coreProgram;
        whSplTokenProgram          = wh.splTokenProgram;
        whSystemProgram            = wh.systemProgram;
        whClockSysvar              = wh.clockSysvar;
        whRentSysvar               = wh.rentSysvar;
        wormholeConfig             = wh.config;
        wormholeCustody            = wh.custody;
        wormholeAuthoritySigner    = wh.authoritySigner;
        wormholeCustodySigner      = wh.custodySigner;
        wormholeBridgeConfig       = wh.bridgeConfig;
        wormholeFeeCollector       = wh.feeCollector;
        wormholeEmitter            = wh.emitter;
        wormholeSequence           = wh.sequence;
        wormholeWrappedMeta        = wh.wrappedMeta;
    }

    // -------------------------------------------------------------------------
    // CCTP path — path=0
    // -------------------------------------------------------------------------

    /// @notice Burns rUSDC on the Rome EVM and initiates a CCTP deposit_for_burn
    ///         CPI on Solana, bridging funds to `ethereumRecipient` on Ethereum.
    /// @param amount           Token amount in SPL decimals (must fit uint64).
    /// @param ethereumRecipient Destination address on Ethereum.
    function burnUSDC(uint256 amount, address ethereumRecipient) external {
        if (amount > type(uint64).max) {
            revert AmountExceedsUint64(amount);
        }
        address user = _msgSender();
        uint256 balance = usdcWrapper.balanceOf(user);
        if (balance < amount) {
            revert InsufficientBalance(user, amount, balance);
        }

        bytes32 userPda = RomeEVMAccount.pda(user);
        bytes32 userAta = usdcWrapper.getAta(user);

        // Rome PDAs created by ERC20Users.ensure_user.
        // The "PAYER" salt PDA is pre-funded with 1 SOL in ERC20Users.ensure_user,
        // giving it rent to pay for the transient message_sent_event_data account.
        bytes32 payerSalt = Convert.bytes_to_bytes32(bytes("PAYER"));
        bytes32 userPayer = RomeEVMAccount.pda_with_salt(user, payerSalt);

        // Per-tx message data account derived as a PDA under the user.
        // Salt includes per-user nonce instead of block.number — block.number on
        // Rome EVM = Solana slot, unstable across emulation/execution.
        uint64 nonce = burnNonce[user];
        burnNonce[user] = nonce + 1;
        // Include address(this) so redeploys don't collide with previously-used
        // event-data PDAs under the same user.
        bytes32 cctpSalt = keccak256(abi.encodePacked("CCTP_MSG", address(this), nonce));
        bytes32 messageSentEventData = RomeEVMAccount.pda_with_salt(user, cctpSalt);

        bytes memory ixData = CCTPLib.encodeDepositForBurn(CCTPLib.DepositForBurnParams({
            amount:            uint64(amount),
            destinationDomain: CCTPLib.DOMAIN_ETHEREUM,
            mintRecipient:     bytes32(uint256(uint160(ethereumRecipient)))
        }));

        ICrossProgramInvocation.AccountMeta[] memory metas =
            CCTPLib.buildDepositForBurnAccounts(
                CCTPLib.DepositForBurnAccounts({
                    owner:                       userPda,
                    eventRentPayer:              userPayer,
                    senderAuthorityPda:          cctpSenderAuthorityPda,
                    burnTokenAccount:            userAta,
                    messageTransmitter:          cctpMessageTransmitterConfig,
                    tokenMessenger:              cctpTokenMessengerConfig,
                    remoteTokenMessenger:        cctpRemoteTokenMessenger,
                    tokenMinter:                 cctpTokenMinter,
                    localToken:                  cctpLocalTokenUsdc,
                    burnTokenMint:               usdcMint,
                    messageSentEventData:        messageSentEventData,
                    messageTransmitterProgram:   cctpMessageTransmitterProgram,
                    tokenMessengerMinterProgram: cctpTokenMessengerProgram,
                    tokenProgram:                cctpSplTokenProgram,
                    systemProgram:               cctpSystemProgram,
                    eventAuthority:              cctpEventAuthority,
                    program:                     cctpTokenMessengerProgram
                })
            );

        // Signing salts for Rome's invoke_signed — we need the user's "PAYER"
        // salt (to sign for eventRentPayer) and the per-tx CCTP_MSG salt (to
        // sign for messageSentEventData). The base user PDA (owner) is signed
        // implicitly from the tx-caller's EVM address, per orra.sol convention.
        bytes32[] memory salts = new bytes32[](2);
        salts[0] = payerSalt;
        salts[1] = cctpSalt;

        (bool ok, bytes memory result) = address(CpiProgram).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                cctpTokenMessengerProgram,
                metas,
                ixData,
                salts
            )
        );
        if (!ok) revert CpiFailed(result);

        emit Withdrawn(user, usdcMint, amount, ethereumRecipient, 0);
    }

    // -------------------------------------------------------------------------
    // Wormhole path — path=1
    // -------------------------------------------------------------------------

    /// @notice Delegates the Wormhole Token Bridge `authority_signer` PDA as
    ///         the burn delegate on the caller's wETH ATA. Must be invoked in
    ///         a separate EVM transaction before `burnETH` — splitting the two
    ///         CPIs across transactions keeps each Rome atomic DoTx within the
    ///         1.4M Solana compute budget.
    /// @param amount Burn allowance to delegate (base units; uint64-bounded).
    function approveBurnETH(uint256 amount) external {
        if (amount > type(uint64).max) {
            revert AmountExceedsUint64(amount);
        }
        address user = _msgSender();

        bytes32 userPda = RomeEVMAccount.pda(user);
        bytes32 userAta = wethWrapper.getAta(user);

        bytes32[] memory emptySigners = new bytes32[](0);
        (, ICrossProgramInvocation.AccountMeta[] memory approveMetas, bytes memory approveIx) =
            SplTokenLib.approve(
                whSplTokenProgram,
                userAta,
                wormholeAuthoritySigner,
                userPda,
                emptySigners,
                uint64(amount)
            );
        bytes32[] memory noSalts = new bytes32[](0);
        (bool ok, bytes memory result) = address(CpiProgram).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                whSplTokenProgram,
                approveMetas,
                approveIx,
                noSalts
            )
        );
        if (!ok) revert CpiFailed(result);
    }

    /// @notice Burns rWETH on the Rome EVM and initiates a Wormhole transfer_tokens
    ///         CPI on Solana, bridging funds to `ethereumRecipient` on Ethereum.
    /// @param amount           Token amount in SPL decimals (must fit uint64).
    /// @param ethereumRecipient Destination address on Ethereum.
    /// @dev Split into two EVM transactions for compute-budget reasons:
    ///      (1) caller first invokes `approveBurnETH(amount)` — a single CPI
    ///          that delegates Wormhole's authority_signer to burn the user's
    ///          ATA. Kept out of burnETH because atomic Rome DoTx + two Solana
    ///          CPIs consumes the full 1.4M CU budget before transfer_wrapped
    ///          finishes its inner burn/post-message CPIs.
    ///      (2) then invokes `burnETH` which does only the transfer_wrapped
    ///          CPI (requires the delegation from step 1 to be in place).
    function burnETH(uint256 amount, address ethereumRecipient) external {
        if (amount > type(uint64).max) {
            revert AmountExceedsUint64(amount);
        }
        address user = _msgSender();
        uint256 balance = wethWrapper.balanceOf(user);
        if (balance < amount) {
            revert InsufficientBalance(user, amount, balance);
        }

        bytes32 userPda  = RomeEVMAccount.pda(user);
        bytes32 userAta  = wethWrapper.getAta(user);

        // PAYER salt PDA — pre-funded by ERC20Users.ensure_user with enough
        // SOL to cover the transient message account rent in Wormhole's
        // init_if_needed. userPda itself has no SOL.
        bytes32 payerSalt = Convert.bytes_to_bytes32(bytes("PAYER"));
        bytes32 userPayer = RomeEVMAccount.pda_with_salt(user, payerSalt);

        // Per-tx Wormhole message account derived as a PDA under the user.
        uint64 nonce = burnNonce[user];
        burnNonce[user] = nonce + 1;
        bytes32 whSalt = keccak256(abi.encodePacked("WH_MSG", address(this), nonce));
        bytes32 messageAccount = RomeEVMAccount.pda_with_salt(user, whSalt);

        bytes memory ixData = WormholeTokenBridgeLib.encodeTransferTokens(
            WormholeTokenBridgeLib.TransferParams({
                amount:        uint64(amount),
                fee:           0,
                targetAddress: bytes32(uint256(uint160(ethereumRecipient))),
                targetChain:   2, // Ethereum Wormhole chain ID
                nonce:         uint32(block.timestamp)
            })
        );

        ICrossProgramInvocation.AccountMeta[] memory metas =
            WormholeTokenBridgeLib.buildTransferWrappedAccounts(
                WormholeTokenBridgeLib.TransferWrappedAccounts({
                    payer:            userPayer,
                    config:           wormholeConfig,
                    from:             userAta,
                    from_owner:       userPda,
                    mint:             wethMint,
                    wrapped_meta:     wormholeWrappedMeta,
                    authority_signer: wormholeAuthoritySigner,
                    bridge_config:    wormholeBridgeConfig,
                    message:          messageAccount,
                    emitter:          wormholeEmitter,
                    sequence:         wormholeSequence,
                    fee_collector:    wormholeFeeCollector,
                    clock:            whClockSysvar,
                    rent:             whRentSysvar,
                    system:           whSystemProgram,
                    wormhole_core:    wormholeCoreProgram,
                    token:            whSplTokenProgram
                })
            );

        // Signing salts: PAYER (pre-funded sub-account used as payer) + WH_MSG
        // (per-tx Wormhole message account).
        bytes32[] memory salts = new bytes32[](2);
        salts[0] = payerSalt;
        salts[1] = whSalt;

        (bool ok, bytes memory result) = address(CpiProgram).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                wormholeTokenBridgeProgram,
                metas,
                ixData,
                salts
            )
        );
        if (!ok) revert CpiFailed(result);

        emit Withdrawn(user, wethMint, amount, ethereumRecipient, 1);
    }

    // -------------------------------------------------------------------------
    // ERC2771Context override
    // -------------------------------------------------------------------------

    function _contextSuffixLength() internal pure override returns (uint256) {
        return 20;
    }
}
