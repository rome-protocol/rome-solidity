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
    bytes32 public immutable cctpSplTokenProgram;
    bytes32 public immutable cctpSystemProgram;
    bytes32 public immutable cctpMessageTransmitterConfig;
    bytes32 public immutable cctpTokenMessengerConfig;
    bytes32 public immutable cctpRemoteTokenMessenger;
    bytes32 public immutable cctpTokenMinter;
    bytes32 public immutable cctpLocalTokenUsdc;
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
        /// @dev CCTP Token Messenger Solana program ID
        ///      (CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3)
        bytes32 tokenMessengerProgram;
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
        bytes32 custody;
        bytes32 authoritySigner;
        bytes32 custodySigner;
        bytes32 bridgeConfig;
        bytes32 feeCollector;
        bytes32 emitter;
        bytes32 sequence;
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
        cctpTokenMessengerProgram    = cctp.tokenMessengerProgram;
        cctpSplTokenProgram          = cctp.splTokenProgram;
        cctpSystemProgram            = cctp.systemProgram;
        cctpMessageTransmitterConfig = cctp.messageTransmitterConfig;
        cctpTokenMessengerConfig     = cctp.tokenMessengerConfig;
        cctpRemoteTokenMessenger     = cctp.remoteTokenMessenger;
        cctpTokenMinter              = cctp.tokenMinter;
        cctpLocalTokenUsdc           = cctp.localTokenUsdc;
        cctpEventAuthority           = cctp.eventAuthority;
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
                cctpSplTokenProgram,
                cctpSystemProgram,
                cctpEventAuthority,
                cctpTokenMessengerProgram
            );

        // Signing salt for the per-tx event-data PDA (signed alongside the user PDA
        // which is derived implicitly from the caller's EVM address).
        bytes32[] memory salts = new bytes32[](1);
        salts[0] = cctpSalt;

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

    /// @notice Burns rWETH on the Rome EVM and initiates a Wormhole transfer_tokens
    ///         CPI on Solana, bridging funds to `ethereumRecipient` on Ethereum.
    /// @param amount           Token amount in SPL decimals (must fit uint64).
    /// @param ethereumRecipient Destination address on Ethereum.
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
                    clock:            whClockSysvar,
                    rent:             whRentSysvar,
                    system:           whSystemProgram,
                    token:            whSplTokenProgram,
                    wormhole_core:    wormholeCoreProgram
                })
            );

        // Signing salt for the per-tx Wormhole message account PDA.
        bytes32[] memory salts = new bytes32[](1);
        salts[0] = whSalt;

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
