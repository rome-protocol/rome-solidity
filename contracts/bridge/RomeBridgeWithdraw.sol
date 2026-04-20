// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {SPL_ERC20} from "../erc20spl/erc20spl.sol";
import {CCTPLib} from "./ICCTP.sol";
import {WormholeTokenBridgeLib} from "./IWormholeTokenBridge.sol";
import {ICrossProgramInvocation, CpiProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {RomeBridgeEvents} from "./RomeBridgeEvents.sol";

/// @title RomeBridgeWithdraw
/// @notice Accepts rToken input on Rome EVM, emits outbound CCTP or Wormhole
///         message via CPI signed as the user's Rome-derived PDA.
/// @dev CCTP path:     burnUSDC → depositForBurn CPI (path=0)
///      Wormhole path: burnETH  → transfer_tokens CPI  (path=1)
///
///      Solana program PDAs (CCTP configs, Wormhole custody etc.) are supplied
///      at construction from the deploy script after off-chain derivation.
///      Many bytes32 pubkeys below are placeholder values marked FIXME —
///      the Phase 1.5 deploy script will supply real values derived via
///      find_program_address / known Solana constants.
contract RomeBridgeWithdraw is ERC2771Context, RomeBridgeEvents {
    SPL_ERC20 public immutable usdcWrapper;
    SPL_ERC20 public immutable wethWrapper;
    bytes32 public immutable usdcMint;
    bytes32 public immutable wethMint;

    // -------------------------------------------------------------------------
    // CCTP Solana-side PDA references (set at construction from deploy script)
    // -------------------------------------------------------------------------
    bytes32 public immutable cctpMessageTransmitterConfig;
    bytes32 public immutable cctpTokenMessengerConfig;
    bytes32 public immutable cctpRemoteTokenMessenger;
    bytes32 public immutable cctpTokenMinter;
    bytes32 public immutable cctpLocalTokenUsdc;
    bytes32 public immutable cctpEventAuthority;

    // -------------------------------------------------------------------------
    // Wormhole Solana-side PDA references (set at construction from deploy script)
    // -------------------------------------------------------------------------
    bytes32 public immutable wormholeConfig;
    bytes32 public immutable wormholeCustody;
    bytes32 public immutable wormholeAuthoritySigner;
    bytes32 public immutable wormholeCustodySigner;
    bytes32 public immutable wormholeBridgeConfig;
    bytes32 public immutable wormholeFeeCollector;
    /// @dev FIXME: supply real emitter PDA from deploy; Phase 1.5 will derive on-chain
    bytes32 public immutable wormholeEmitter;
    /// @dev FIXME: supply real sequence PDA from deploy; Phase 1.5 will derive on-chain
    bytes32 public immutable wormholeSequence;
    bytes32 public immutable wormholeCoreProgram;

    // -------------------------------------------------------------------------
    // Well-known Solana program / sysvar pubkeys
    // -------------------------------------------------------------------------

    /// @dev SPL Token program pubkey (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA).
    /// FIXME: Replace with real pubkey in Phase 1.4 deploy refactor; currently sentinel zero
    ///        forces CpiFailed rather than silent miswrite.
    bytes32 internal constant SPL_TOKEN_PROGRAM =
        0x0000000000000000000000000000000000000000000000000000000000000000;

    /// @dev System program pubkey — 11111111111111111111111111111111 decodes to 32 zero bytes.
    bytes32 internal constant SYSTEM_PROGRAM =
        0x0000000000000000000000000000000000000000000000000000000000000000;

    /// @dev Clock sysvar pubkey (SysvarC1ock11111111111111111111111111111111).
    /// FIXME: Replace with real pubkey in Phase 1.4 deploy refactor; currently sentinel zero
    ///        forces CpiFailed rather than silent miswrite.
    bytes32 internal constant CLOCK_SYSVAR =
        0x0000000000000000000000000000000000000000000000000000000000000000;

    /// @dev Rent sysvar pubkey (SysvarRent111111111111111111111111111111111).
    /// FIXME: Replace with real pubkey in Phase 1.4 deploy refactor; currently sentinel zero
    ///        forces CpiFailed rather than silent miswrite.
    bytes32 internal constant RENT_SYSVAR =
        0x0000000000000000000000000000000000000000000000000000000000000000;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------
    error AmountExceedsUint64(uint256 amount);
    error InsufficientBalance(address user, uint256 requested, uint256 available);
    error CpiFailed(bytes reason);

    // -------------------------------------------------------------------------
    // Constructor params structs (avoids stack-too-deep with 19 constructor args)
    // -------------------------------------------------------------------------

    struct CctpParams {
        bytes32 msgTransmitterConfig;
        bytes32 tokenMessengerConfig;
        bytes32 remoteTokenMessenger;
        bytes32 tokenMinter;
        bytes32 localTokenUsdc;
        bytes32 eventAuthority;
    }

    struct WormholeParams {
        bytes32 config;
        bytes32 custody;
        bytes32 authoritySigner;
        bytes32 custodySigner;
        bytes32 bridgeConfig;
        bytes32 feeCollector;
        bytes32 emitter;
        bytes32 sequence;
        bytes32 coreProgram;
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
        cctpMessageTransmitterConfig = cctp.msgTransmitterConfig;
        cctpTokenMessengerConfig     = cctp.tokenMessengerConfig;
        cctpRemoteTokenMessenger     = cctp.remoteTokenMessenger;
        cctpTokenMinter              = cctp.tokenMinter;
        cctpLocalTokenUsdc           = cctp.localTokenUsdc;
        cctpEventAuthority           = cctp.eventAuthority;
        // Wormhole
        wormholeConfig          = wh.config;
        wormholeCustody         = wh.custody;
        wormholeAuthoritySigner = wh.authoritySigner;
        wormholeCustodySigner   = wh.custodySigner;
        wormholeBridgeConfig    = wh.bridgeConfig;
        wormholeFeeCollector    = wh.feeCollector;
        wormholeEmitter         = wh.emitter;
        wormholeSequence        = wh.sequence;
        wormholeCoreProgram     = wh.coreProgram;
    }

    // -------------------------------------------------------------------------
    // CCTP path — path=0
    // -------------------------------------------------------------------------

    /// @notice Burns rUSDC on the Rome EVM and initiates a CCTP deposit_for_burn
    ///         CPI on Solana, bridging funds to `ethereumRecipient` on Ethereum.
    /// @param amount           Token amount in SPL decimals (must fit uint64).
    /// @param ethereumRecipient Destination address on Ethereum.
    function burnUSDC(uint256 amount, address ethereumRecipient) external {
        if (SPL_TOKEN_PROGRAM == bytes32(0) || CLOCK_SYSVAR == bytes32(0) || RENT_SYSVAR == bytes32(0)) {
            revert CpiFailed(bytes("sysvar constants not initialized"));
        }
        if (amount > type(uint64).max) {
            revert AmountExceedsUint64(amount);
        }
        address user = _msgSender();
        uint256 balance = usdcWrapper.balanceOf(user);
        if (balance < amount) {
            revert InsufficientBalance(user, amount, balance);
        }

        bytes32 userPda  = RomeEVMAccount.pda(user);
        bytes32 userAta  = usdcWrapper.getAta(user);

        bytes memory ixData = CCTPLib.encodeDepositForBurn(CCTPLib.DepositForBurnParams({
            amount:            uint64(amount),
            destinationDomain: CCTPLib.DOMAIN_ETHEREUM,
            mintRecipient:     bytes32(uint256(uint160(ethereumRecipient)))
        }));

        // Per-tx message data account derived as a PDA under the user.
        // Includes block.number in the salt so concurrent same-slot txs don't collide.
        bytes32 cctpSalt = keccak256(abi.encodePacked("CCTP_MSG", block.number));
        bytes32 messageSentEventData = RomeEVMAccount.pda_with_salt(user, cctpSalt);

        ICrossProgramInvocation.AccountMeta[] memory metas =
            CCTPLib.buildDepositForBurnAccounts(
                userPda,
                usdcMint,
                userAta,
                cctpMessageTransmitterConfig,
                cctpTokenMessengerConfig,
                cctpRemoteTokenMessenger,
                cctpTokenMinter,
                cctpLocalTokenUsdc,
                messageSentEventData,
                SPL_TOKEN_PROGRAM,
                SYSTEM_PROGRAM,
                cctpEventAuthority,
                CCTPLib.TOKEN_MESSENGER_PROGRAM
            );

        // Signing salt for the per-tx event-data PDA (signed alongside the user PDA
        // which is derived implicitly from the caller's EVM address).
        bytes32[] memory salts = new bytes32[](1);
        salts[0] = cctpSalt;

        (bool ok, bytes memory result) = address(CpiProgram).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                CCTPLib.TOKEN_MESSENGER_PROGRAM,
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

    /// @notice Burns rWETH on the Rome EVM and initiates a Wormhole transfer_tokens
    ///         CPI on Solana, bridging funds to `ethereumRecipient` on Ethereum.
    /// @param amount           Token amount in SPL decimals (must fit uint64).
    /// @param ethereumRecipient Destination address on Ethereum.
    function burnETH(uint256 amount, address ethereumRecipient) external {
        if (SPL_TOKEN_PROGRAM == bytes32(0) || CLOCK_SYSVAR == bytes32(0) || RENT_SYSVAR == bytes32(0)) {
            revert CpiFailed(bytes("sysvar constants not initialized"));
        }
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

        // Per-tx Wormhole message account derived as a PDA under the user.
        // Includes block.number in the salt so concurrent same-slot txs don't collide.
        bytes32 whSalt = keccak256(abi.encodePacked("WH_MSG", block.number));
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
            WormholeTokenBridgeLib.buildAccounts(
                WormholeTokenBridgeLib.TransferAccounts({
                    payer:            userPda,
                    config:           wormholeConfig,
                    from_owner:       userPda,         // PDA signer
                    from:             userAta,
                    mint:             wethMint,
                    custody:          wormholeCustody,
                    authority_signer: wormholeAuthoritySigner,
                    custody_signer:   wormholeCustodySigner,
                    bridge_config:    wormholeBridgeConfig,
                    message:          messageAccount,
                    emitter:          wormholeEmitter,
                    sequence:         wormholeSequence,
                    fee_collector:    wormholeFeeCollector,
                    clock:            CLOCK_SYSVAR,
                    rent:             RENT_SYSVAR,
                    system:           SYSTEM_PROGRAM,
                    token:            SPL_TOKEN_PROGRAM,
                    wormhole_core:    wormholeCoreProgram
                })
            );

        // Signing salt for the per-tx Wormhole message account PDA.
        bytes32[] memory salts = new bytes32[](1);
        salts[0] = whSalt;

        (bool ok, bytes memory result) = address(CpiProgram).delegatecall(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                WormholeTokenBridgeLib.PROGRAM_ID,
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
