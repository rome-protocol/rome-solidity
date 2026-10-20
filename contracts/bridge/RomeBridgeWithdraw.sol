// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {SPL_ERC20} from "../erc20spl/erc20spl.sol";
import {CCTPV2Lib} from "./ICCTPV2.sol";
import {PdaDeriver} from "../cpi/PdaDeriver.sol";
import {ISystemProgram} from "../interface.sol";
import {WormholeTokenBridgeLib} from "./IWormholeTokenBridge.sol";
import {ICrossProgramInvocation, CpiProgram, HelperProgram} from "../interface.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {RomeBridgeEvents} from "./RomeBridgeEvents.sol";
import {UserPda} from "../cpi/UserPda.sol";


/// @title RomeBridgeWithdraw
/// @notice Accepts rToken input on Rome EVM, emits outbound CCTP or Wormhole
///         message via CPI signed as the user's Rome-derived PDA.
/// @dev CCTP path:     burnUSDC → CCTP **v2** deposit_for_burn CPI (path=0),
///                     per-call destination domain. v2 is required for
///                     v2-only destinations (Monad = 15) and is the
///                     go-forward protocol for every destination.
///      Wormhole path: burnToWormhole / transferNativeToWormhole (path=1)
///
///      v13 (13.0.0): the CCTP destination list is owner-managed after
///      deployment (`enableCctpDomain` / `disableCctpDomain`), so a new CCTP
///      chain never needs a redeploy. The legacy ETH-only `burnETH` path is
///      gone; `burnToWormhole` covers wETH like any other asset.
///
///      All Solana program IDs, sysvars, and PDAs are supplied at construction
///      from the deploy script. No pubkeys are hardcoded in this contract —
///      it is fully network-agnostic.
///
///      The constructor refuses a non-zero ERC-2771 forwarder: a forwarder
///      could append any user's address and burn that user's balance (every
///      user keeps a standing delegate to this contract). With a zero
///      forwarder `_msgSender()` is `msg.sender`. Admin authority uses
///      `msg.sender` directly anyway, so it never depends on that.
contract RomeBridgeWithdraw is ERC2771Context, RomeBridgeEvents {
    /// @notice Contract version, bumped with every behaviour change.
    string public constant VERSION = "13.0.0";

    SPL_ERC20 public immutable usdcWrapper;
    bytes32 public immutable usdcMint;

    // -------------------------------------------------------------------------
    // CCTP Solana-side immutables (set at construction from deploy script)
    // -------------------------------------------------------------------------
    bytes32 public immutable cctpTokenMessengerProgram;
    bytes32 public immutable cctpMessageTransmitterProgram;
    bytes32 public immutable cctpSplTokenProgram;
    bytes32 public immutable cctpSystemProgram;
    bytes32 public immutable cctpMessageTransmitterConfig;
    bytes32 public immutable cctpTokenMessengerConfig;
    bytes32 public immutable cctpTokenMinter;
    bytes32 public immutable cctpLocalTokenUsdc;
    bytes32 public immutable cctpSenderAuthorityPda;
    bytes32 public immutable cctpEventAuthority;
    bytes32 public immutable cctpMessageTransmitterEventAuthority;

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
    bytes32 public immutable wormholeAuthoritySigner;
    bytes32 public immutable wormholeCustodySigner;
    bytes32 public immutable wormholeBridgeConfig;
    bytes32 public immutable wormholeFeeCollector;
    bytes32 public immutable wormholeEmitter;
    bytes32 public immutable wormholeSequence;

    // -------------------------------------------------------------------------
    // CCTP destinations (owner-managed since v13)
    // -------------------------------------------------------------------------

    /// @notice Recipient encodings a CCTP destination can use.
    ///         NONE (0) is the value of a domain that is not enabled.
    ///         EVM (1): the recipient is a 20-byte address, left-padded to 32 bytes.
    ///         RAW32 (2): the recipient is a full 32-byte value (Sui, Aptos and the
    ///         like). Only `burnUSDCToBytes32` can burn to these.
    uint8 public constant RECIPIENT_NONE = 0;
    uint8 public constant RECIPIENT_EVM = 1;
    uint8 public constant RECIPIENT_RAW32 = 2;

    /// @dev Circle domains this contract's burn format cannot serve, so
    ///      `enableCctpDomain` refuses them even though Circle has a
    ///      RemoteTokenMessenger for them. A real messenger proves Circle
    ///      registered the chain, not that this burn is compatible with it.
    ///      5  Solana: an address-typed burn there is unredeemable.
    ///      17 BNB Smart Chain: Circle moves USYC there, not USDC, and this
    ///         contract burns USDC only.
    ///      27 Stellar: Circle requires its CctpForwarder as both mint recipient
    ///         and destination caller, with the user's address in hook data; this
    ///         contract sends the user's key as recipient with no destination
    ///         caller and no hook data, so funds could be stuck for good.
    ///      Supporting any of them needs a dedicated, tested encoding path in a
    ///      later version.
    uint32 public constant DOMAIN_SOLANA = 5;
    uint32 public constant DOMAIN_BNB = 17;
    uint32 public constant DOMAIN_STELLAR = 27;

    /// @notice CCTP destination allowlist: Circle domain → RemoteTokenMessenger
    ///         PDA (["remote_token_messenger", ascii(domain)] under the v2 TMM).
    ///         Filled by `enableCctpDomain` after the contract has read Circle's
    ///         own record of that domain. It is both the per-destination account
    ///         CCTP requires and the guard that stops a burn to a domain Rome has
    ///         not switched on. Zero = not enabled.
    /// @dev The PDA and the recipient kind live in one struct on purpose: a
    ///      burn reads both, and on Rome every distinct storage slot a call
    ///      touches can pull another storage account into the transaction. In
    ///      one struct the two values sit in consecutive slots. The two public
    ///      views below keep the ABI of the separate mappings.
    struct CctpDest {
        bytes32 remoteTokenMessenger; // zero = not enabled
        uint8 kind;                   // RECIPIENT_*
    }
    mapping(uint32 => CctpDest) private _cctpDest;

    /// @notice The RemoteTokenMessenger PDA of an enabled domain (zero if none).
    function cctpRemoteTokenMessengers(uint32 domain) external view returns (bytes32) {
        return _cctpDest[domain].remoteTokenMessenger;
    }

    /// @notice How the recipient of an enabled domain is encoded (RECIPIENT_*).
    function cctpRecipientKind(uint32 domain) external view returns (uint8) {
        return _cctpDest[domain].kind;
    }

    // Enumerable set of enabled domains: array plus 1-based index (0 = absent).
    uint32[] private _cctpDomains;
    mapping(uint32 => uint256) private _cctpDomainIndex;

    /// @notice Per-user burn counter used to derive unique message PDAs per tx.
    /// @dev We can't use block.number in the salt — on Rome EVM, block.number
    ///      returns the Solana slot (the Rome EVM program
    ///      block_number() → self.slot), which changes between eth_call
    ///      simulation and on-chain execution. That divergence causes the
    ///      emulator to pass one messageSentEventData PDA and the on-chain
    ///      program to look up a different one → AccountNotFound. A user-scoped
    ///      monotonic counter is stable across the emulation/execution boundary
    ///      within the same tx and unique across txs.
    mapping(address => uint64) public burnNonce;

    /// @notice Generic-Wormhole target-chain allowlist: Wormhole chain id →
    ///         allowed. Fail-closed — `burnToWormhole` to an unlisted chain
    ///         reverts. Seeded at construction and managed by the owner.
    mapping(uint16 => bool) public wormholeTargetChainAllowed;

    /// @notice Generic-Wormhole asset allowlist, keyed on the SPL MINT (not the
    ///         wrapper instance). All ERC20-SPL wrappers over one mint are fungible
    ///         views of the same on-chain ATA, so keying on the mint accepts any
    ///         wrapper over an allowed asset and kills the multi-wrapper drift
    ///         class. The public API stays wrapper-typed via the
    ///         `wormholeAssetAllowed(address)` view below — callers are unchanged.
    mapping(bytes32 => bool) public wormholeMintAllowed;

    // -------------------------------------------------------------------------
    // Roles and pause state
    // -------------------------------------------------------------------------

    /// @notice Admin: enables CCTP domains, manages the Wormhole allowlists and
    ///         message rents, unpauses, sets the guardian, creates bridge ATAs and
    ///         hands ownership on (two steps). Set in the constructor, so there is
    ///         no hand-over gap. Every value path (burnUSDC, burnToWormhole,
    ///         transferNativeToWormhole, bridgeOutToSolana) is permissionless.
    address public owner;

    /// @notice Owner-to-be, set by `transferOwnership`, cleared when accepted.
    address public pendingOwner;

    /// @notice Stop-only key (a hot ops key). It can pause a rail and disable a
    ///         CCTP domain. It cannot unpause, enable anything or move funds.
    ///         address(0) means no guardian.
    address public guardian;

    /// @notice The three outbound rails that can be paused one at a time.
    enum Rail {
        CCTP,       // burnUSDC (both overloads), burnUSDCToBytes32
        WORMHOLE,   // burnToWormhole, transferNativeToWormhole
        TO_SOLANA   // bridgeOutToSolana, ensureRecipientAta
    }

    /// @dev Bit `1 << uint8(rail)` is set while that rail is paused.
    uint8 private _pausedMask;

    /// @dev Admin checks use msg.sender on purpose, see the contract notes.
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    modifier whenNotPaused(Rail rail) {
        if (_pausedMask & (1 << uint8(rail)) != 0) revert RailPaused(rail);
        _;
    }

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------
    error AmountExceedsUint64(uint256 amount);
    error InsufficientBalance(address user, uint256 requested, uint256 available);
    error CpiFailed(bytes reason);
    error UnsupportedDestinationDomain(uint32 domain);
    error ZeroRecipient();
    error UnsupportedTargetChain(uint16 targetChain);
    error UnsupportedAssetWrapper(address assetWrapper);
    error NotOwner(address caller);
    error NotOwnerOrGuardian(address caller);
    error NotPendingOwner(address caller);
    error ZeroOwner();
    error ForwarderNotAllowed(address forwarder);
    error SubGranularityAmount(uint256 amount, uint256 granularity);
    error RailPaused(Rail rail);
    error RailNotPaused(Rail rail);
    error InvalidRecipientKind(uint8 kind);
    error RecipientKindMismatch(uint32 domain, uint8 domainKind, uint8 requiredKind);
    error CctpDomainNotEnabled(uint32 domain);
    /// @dev Circle's RemoteTokenMessenger account for the domain is missing,
    ///      owned by another program, has the wrong discriminator or length,
    ///      or records a different domain.
    error InvalidCctpAccount(uint32 domain, bytes32 account);
    /// @dev An EVM-kind domain whose Circle messenger is not a 20-byte address
    ///      (for example Sui or Aptos): a burn there would be unrecoverable.
    error MessengerNotEvmShaped(uint32 domain, bytes32 messenger);
    /// @dev A RAW32-kind domain whose Circle messenger IS a 20-byte address
    ///      (12 leading zero bytes): an EVM chain. Its receiver keeps only the
    ///      low 20 bytes of the recipient, so a 32-byte recipient can truncate to
    ///      a different address or to zero, and the burned USDC could not be
    ///      redeemed. EVM chains stay on the address entry points.
    error MessengerNotRaw32Shaped(uint32 domain, bytes32 messenger);

    // -------------------------------------------------------------------------
    // Admin events
    // -------------------------------------------------------------------------
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event GuardianSet(address indexed previousGuardian, address indexed newGuardian);
    event WormholeAssetAllowedSet(address indexed assetWrapper, bool allowed);
    event WormholeTargetChainAllowedSet(uint16 indexed targetChain, bool allowed);
    event CctpDomainEnabled(
        uint32 indexed domain,
        uint8 recipientKind,
        bytes32 remoteTokenMessengerPda,
        bytes32 circleMessenger
    );
    event CctpDomainDisabled(uint32 indexed domain, address indexed by);
    event RailPausedSet(Rail indexed rail, address indexed by);
    event RailUnpausedSet(Rail indexed rail, address indexed by);

    // -------------------------------------------------------------------------
    // Constructor params structs (avoids stack-too-deep with many constructor args)
    // -------------------------------------------------------------------------

    /// @notice CCTP-path Solana accounts. Includes all program IDs and PDAs needed
    ///         for the deposit_for_burn CPI. All fields come from the deploy script.
    ///         Destination domains are NOT part of the constructor: the owner
    ///         enables them afterwards with `enableCctpDomain`.
    struct CctpParams {
        /// @dev CCTP **v2** Token Messenger Minter Solana program ID
        ///      (CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe)
        bytes32 tokenMessengerProgram;
        /// @dev CCTP **v2** Message Transmitter Solana program ID
        ///      (CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC)
        bytes32 messageTransmitterProgram;
        /// @dev SPL Token program ID (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
        bytes32 splTokenProgram;
        /// @dev Solana System Program (11111111111111111111111111111111 → zero bytes)
        bytes32 systemProgram;
        // PDAs — derived per-deployment
        bytes32 messageTransmitterConfig;
        bytes32 tokenMessengerConfig;
        bytes32 tokenMinter;
        bytes32 localTokenUsdc;
        /// @dev ["sender_authority"] PDA under Token Messenger Minter program
        bytes32 senderAuthorityPda;
        /// @dev TMM's __event_authority — for outer event_cpi
        bytes32 eventAuthority;
        /// @dev MessageTransmitter's __event_authority — required as the
        /// 18th meta so the post-#266 Mollusk emulator's `ix_store` filter
        /// loads it for the inner CPI to send_message_with_caller.
        bytes32 messageTransmitterEventAuthority;
    }

    /// @notice Wormhole-path Solana accounts. Includes all program IDs, sysvars, and
    ///         PDAs needed for the transfer CPIs. All fields come from the deploy script.
    ///         Per-mint accounts (wrapped_meta, custody) are derived at call time.
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
        // PDAs — derived per-deployment
        bytes32 config;
        bytes32 authoritySigner;
        bytes32 custodySigner;
        bytes32 bridgeConfig;
        bytes32 feeCollector;
        bytes32 emitter;
        bytes32 sequence;
    }

    /// @notice Generic-Wormhole config and the owner: per-call target-chain
    ///         allowlist + registered asset wrappers (`burnToWormhole`,
    ///         `transferNativeToWormhole`). Both lists are only a SEED; the owner
    ///         manages them afterwards. Pass empty lists to start with Wormhole
    ///         switched off.
    struct WormholeGenericConfig {
        address admin;            // the owner (see `owner`)
        uint16[] targetChains;    // Wormhole chain ids allowed as burnToWormhole destinations
        address[] assetWrappers;  // SPL_ERC20 wrappers allowed as burnToWormhole assets
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(
        address forwarder,
        SPL_ERC20 _usdc,
        CctpParams memory cctp,
        WormholeParams memory wh,
        WormholeGenericConfig memory whg,
        address _guardian
    ) ERC2771Context(forwarder) {
        // A forwarder could append any address to calldata and burn that user's
        // balance (users keep a standing delegate to this contract), so none is
        // accepted. The parameter stays so the constructor ABI is unchanged.
        if (forwarder != address(0)) revert ForwarderNotAllowed(forwarder);
        usdcWrapper = _usdc;
        usdcMint = _usdc.mint_id();
        // CCTP
        cctpTokenMessengerProgram     = cctp.tokenMessengerProgram;
        cctpMessageTransmitterProgram = cctp.messageTransmitterProgram;
        cctpSplTokenProgram           = cctp.splTokenProgram;
        cctpSystemProgram             = cctp.systemProgram;
        cctpMessageTransmitterConfig  = cctp.messageTransmitterConfig;
        cctpTokenMessengerConfig      = cctp.tokenMessengerConfig;
        cctpTokenMinter               = cctp.tokenMinter;
        cctpLocalTokenUsdc            = cctp.localTokenUsdc;
        cctpSenderAuthorityPda        = cctp.senderAuthorityPda;
        cctpEventAuthority            = cctp.eventAuthority;
        cctpMessageTransmitterEventAuthority = cctp.messageTransmitterEventAuthority;
        // Wormhole
        wormholeTokenBridgeProgram = wh.tokenBridgeProgram;
        wormholeCoreProgram        = wh.coreProgram;
        whSplTokenProgram          = wh.splTokenProgram;
        whSystemProgram            = wh.systemProgram;
        whClockSysvar              = wh.clockSysvar;
        whRentSysvar               = wh.rentSysvar;
        wormholeConfig             = wh.config;
        wormholeAuthoritySigner    = wh.authoritySigner;
        wormholeCustodySigner      = wh.custodySigner;
        wormholeBridgeConfig       = wh.bridgeConfig;
        wormholeFeeCollector       = wh.feeCollector;
        wormholeEmitter            = wh.emitter;
        wormholeSequence           = wh.sequence;
        // Owner and guardian are set here, so there is no hand-over gap.
        if (whg.admin == address(0)) revert ZeroOwner();
        owner = whg.admin;
        emit OwnershipTransferred(address(0), whg.admin);
        guardian = _guardian;
        emit GuardianSet(address(0), _guardian);
        // Generic-Wormhole allowlists (asset-agnostic + multi-destination egress).
        // Fail-closed SEED: only chains/wrappers listed here can burnToWormhole
        // until `owner` lists more via the setters below.
        for (uint256 i = 0; i < whg.targetChains.length; i++) {
            wormholeTargetChainAllowed[whg.targetChains[i]] = true;
        }
        for (uint256 i = 0; i < whg.assetWrappers.length; i++) {
            wormholeMintAllowed[SPL_ERC20(whg.assetWrappers[i]).mint_id()] = true;
        }
    }

    // -------------------------------------------------------------------------
    // Admin: CCTP destinations
    // -------------------------------------------------------------------------

    /// @notice Enables a CCTP destination domain, or re-checks and updates one
    ///         that is already enabled (idempotent: the domain is listed once, and
    ///         the recipient kind may be changed). Owner only.
    /// @dev The contract derives Circle's RemoteTokenMessenger PDA itself
    ///      (["remote_token_messenger", ascii(domain)] under the v2 Token
    ///      Messenger Minter), so the signer only types a domain number. It then
    ///      reads that account through the account-read precompile and requires:
    ///        - owner == the CCTP v2 Token Messenger Minter program,
    ///        - the RemoteTokenMessenger discriminator,
    ///        - the stored domain == `domain`,
    ///        - domain not 5 (Solana), 17 (BNB: USYC only) or 27 (Stellar: needs
    ///          Circle's CctpForwarder), see DOMAIN_* above,
    ///        - for RECIPIENT_EVM, a messenger whose first 12 bytes are zero,
    ///        - for RECIPIENT_RAW32, a messenger that is NOT address-shaped.
    ///      A domain Circle has not registered cannot be enabled, a non-EVM
    ///      chain cannot be enabled as an EVM destination, and an EVM chain
    ///      cannot be enabled as RAW32 (its receiver would truncate the 32 bytes).
    /// @param domain        Circle CCTP domain id.
    /// @param recipientKind RECIPIENT_EVM (1) or RECIPIENT_RAW32 (2).
    function enableCctpDomain(uint32 domain, uint8 recipientKind) external onlyOwner {
        if (recipientKind != RECIPIENT_EVM && recipientKind != RECIPIENT_RAW32) {
            revert InvalidRecipientKind(recipientKind);
        }
        if (domain == DOMAIN_SOLANA || domain == DOMAIN_BNB || domain == DOMAIN_STELLAR) {
            revert UnsupportedDestinationDomain(domain);
        }

        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(bytes("remote_token_messenger"));
        seeds[1] = ISystemProgram.Seed(bytes(Strings.toString(domain)));
        (bytes32 pda, ) = PdaDeriver.derive(cctpTokenMessengerProgram, seeds);

        bytes32 circleMessenger = _readRemoteTokenMessenger(domain, pda);
        // The recipient format is bound to what Circle's record shows: an
        // address-shaped messenger is an EVM chain (EVM kind only), a full
        // 32-byte messenger is a non-EVM chain (RAW32 kind only).
        bool evmShaped = (circleMessenger >> 160) == bytes32(0);
        if (recipientKind == RECIPIENT_EVM && !evmShaped) {
            revert MessengerNotEvmShaped(domain, circleMessenger);
        }
        if (recipientKind == RECIPIENT_RAW32 && evmShaped) {
            revert MessengerNotRaw32Shaped(domain, circleMessenger);
        }

        _cctpDest[domain] = CctpDest(pda, recipientKind);
        if (_cctpDomainIndex[domain] == 0) {
            _cctpDomains.push(domain);
            _cctpDomainIndex[domain] = _cctpDomains.length;
        }
        emit CctpDomainEnabled(domain, recipientKind, pda, circleMessenger);
    }

    /// @notice Disables a CCTP destination domain at once. Owner or guardian.
    ///         Reverts if the domain is not enabled.
    function disableCctpDomain(uint32 domain) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotOwnerOrGuardian(msg.sender);
        uint256 index = _cctpDomainIndex[domain];
        if (index == 0) revert CctpDomainNotEnabled(domain);

        uint256 last = _cctpDomains.length;
        if (index != last) {
            uint32 moved = _cctpDomains[last - 1];
            _cctpDomains[index - 1] = moved;
            _cctpDomainIndex[moved] = index;
        }
        _cctpDomains.pop();
        delete _cctpDomainIndex[domain];
        delete _cctpDest[domain];
        emit CctpDomainDisabled(domain, msg.sender);
    }

    /// @notice Every enabled CCTP domain, in no particular order. Lets drift
    ///         checks read the live list without scanning logs.
    function cctpDomains() external view returns (uint32[] memory) {
        return _cctpDomains;
    }

    /// @dev Reads Circle's RemoteTokenMessenger account and returns its
    ///      `token_messenger` field (the destination's messenger, 32 bytes).
    ///      Layout (Anchor): 8-byte discriminator, u32 LE domain, 32-byte pubkey.
    function _readRemoteTokenMessenger(uint32 domain, bytes32 pda) private view returns (bytes32 messenger) {
        bytes32 programOwner;
        bytes memory data;
        try CpiProgram.account_info(pda) returns (uint64, bytes32 o, bool, bool, bool, bytes memory d) {
            programOwner = o;
            data = d;
        } catch {
            revert InvalidCctpAccount(domain, pda);
        }
        if (programOwner != cctpTokenMessengerProgram || data.length < 44) {
            revert InvalidCctpAccount(domain, pda);
        }
        // RemoteTokenMessenger discriminator: sha256("account:RemoteTokenMessenger")[..8]
        if (bytes8(data) != bytes8(0x6973ae225fe98afc)) {
            revert InvalidCctpAccount(domain, pda);
        }
        uint32 stored = uint32(uint8(data[8])) | (uint32(uint8(data[9])) << 8)
            | (uint32(uint8(data[10])) << 16) | (uint32(uint8(data[11])) << 24);
        if (stored != domain) revert InvalidCctpAccount(domain, pda);
        assembly {
            messenger := mload(add(data, 44)) // 32 + 12
        }
    }

    // -------------------------------------------------------------------------
    // Admin: pause, guardian, ownership
    // -------------------------------------------------------------------------

    /// @notice Stops one outbound rail. Owner or guardian. Reverts if it is
    ///         already paused, so every pause is a real state change.
    function pauseRail(Rail rail) external {
        if (msg.sender != owner && msg.sender != guardian) revert NotOwnerOrGuardian(msg.sender);
        uint8 bit = uint8(1) << uint8(rail);
        if (_pausedMask & bit != 0) revert RailPaused(rail);
        _pausedMask |= bit;
        emit RailPausedSet(rail, msg.sender);
    }

    /// @notice Restarts a paused rail. Owner only.
    function unpauseRail(Rail rail) external onlyOwner {
        uint8 bit = uint8(1) << uint8(rail);
        if (_pausedMask & bit == 0) revert RailNotPaused(rail);
        _pausedMask &= ~bit;
        emit RailUnpausedSet(rail, msg.sender);
    }

    /// @notice Whether a rail is currently paused.
    function railPaused(Rail rail) external view returns (bool) {
        return _pausedMask & (1 << uint8(rail)) != 0;
    }

    /// @notice Sets the guardian (address(0) removes it). Owner only.
    function setGuardian(address newGuardian) external onlyOwner {
        emit GuardianSet(guardian, newGuardian);
        guardian = newGuardian;
    }

    /// @notice Step 1 of 2: names the next owner. Nothing changes until that
    ///         address calls `acceptOwnership`. Calling it again replaces the
    ///         pending owner; passing address(0) cancels it. Owner only.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2 of 2: the pending owner takes over.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner(msg.sender);
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        delete pendingOwner;
    }

    // -------------------------------------------------------------------------
    // Admin: post-deploy Wormhole allowlist management
    // -------------------------------------------------------------------------

    /// @notice Enable/disable an SPL_ERC20 wrapper as a `burnToWormhole` asset.
    function setWormholeAssetAllowed(address assetWrapper, bool allowed) external onlyOwner {
        wormholeMintAllowed[SPL_ERC20(assetWrapper).mint_id()] = allowed;
        emit WormholeAssetAllowedSet(assetWrapper, allowed);
    }

    /// @notice Back-compat wrapper-typed view: is the mint behind `assetWrapper`
    ///         allowed for burnToWormhole? True for ANY wrapper over an allowed mint.
    function wormholeAssetAllowed(address assetWrapper) external view returns (bool) {
        return wormholeMintAllowed[SPL_ERC20(assetWrapper).mint_id()];
    }

    /// @notice Enable/disable a Wormhole target chain for `burnToWormhole`
    ///         (e.g. Arbitrum 23, Avalanche/Fuji 6) without a redeploy.
    function setWormholeTargetChainAllowed(uint16 targetChain, bool allowed) external onlyOwner {
        wormholeTargetChainAllowed[targetChain] = allowed;
        emit WormholeTargetChainAllowedSet(targetChain, allowed);
    }

    // ── Message-account rent, billed to the user ─────────────────────────
    // Every outbound CPI creates a message account on Solana (CCTP
    // messageSentEventData, Wormhole message) whose rent-exempt deposit is
    // paid by the bridge's own PDA (eventRentPayer / payer = bridgePda).
    // Right before each CPI the bridge calls HelperProgram.swap_gas_to_lamports
    // for that rent: in the rome-evm program this is a System transfer from the
    // OPERATOR's payer to the caller's (the bridge's) PDA, executed with
    // refund_to_signer, so the operator fronts the rent and the user is billed
    // exactly that in gas, atomically. No float on the bridge PDA is needed.
    // Measured on Hadrian 2026-09-21: CCTP 2,824,480; Wormhole 2,477,770 message
    // rent + 10-lamport core fee. Owner-settable so an upstream account-size
    // change needs no redeploy.
    uint64 public cctpMessageRentLamports = 2_824_480;
    uint64 public wormholeMessageRentLamports = 2_477_780;

    error ZeroRent();
    event MessageRentsSet(uint64 cctpLamports, uint64 wormholeLamports);

    function setMessageRents(uint64 cctpLamports, uint64 wormholeLamports) external onlyOwner {
        if (cctpLamports == 0 || wormholeLamports == 0) revert ZeroRent();
        cctpMessageRentLamports = cctpLamports;
        wormholeMessageRentLamports = wormholeLamports;
        emit MessageRentsSet(cctpLamports, wormholeLamports);
    }

    /// @dev Operator -> bridge PDA lamport transfer, billed to the user in gas
    ///      by the program's refund_to_signer hook. Direct CALL: the precompile
    ///      credits msg.sender's (this contract's) PDA.
    function _fundMessageRent(uint64 lamports) private {
        (bool ok, bytes memory result) = address(HelperProgram).call(
            abi.encodeWithSignature("swap_gas_to_lamports(uint64)", lamports)
        );
        if (!ok) revert CpiFailed(result);
    }

    // -------------------------------------------------------------------------
    // CCTP path — path=0
    // -------------------------------------------------------------------------

    /// @notice Back-compat overload: burns to the Ethereum-family domain (0).
    ///         Same ABI the Rome app's live hook calls today; routes through the
    ///         v2 path like every other destination. Domain 0 must be enabled
    ///         with the EVM recipient kind.
    function burnUSDC(uint256 amount, address ethereumRecipient) external whenNotPaused(Rail.CCTP) {
        _burnUSDC(amount, bytes32(uint256(uint160(ethereumRecipient))), 0, RECIPIENT_EVM);
    }

    /// @notice Burns wUSDC on the Rome EVM and initiates a CCTP **v2**
    ///         deposit_for_burn CPI on Solana, bridging to `recipient` on the
    ///         EVM chain identified by `destinationDomain` (Circle domain id:
    ///         Ethereum/Sepolia 0, Avalanche 1, Arbitrum 3, Base 6, Polygon 7,
    ///         Monad 15). The domain must be enabled with the EVM recipient kind.
    /// @param amount            Token amount in SPL decimals (must fit uint64).
    /// @param recipient         Destination address on the target EVM chain.
    /// @param destinationDomain Circle CCTP domain of the destination chain.
    function burnUSDC(uint256 amount, address recipient, uint32 destinationDomain)
        external
        whenNotPaused(Rail.CCTP)
    {
        _burnUSDC(amount, bytes32(uint256(uint160(recipient))), destinationDomain, RECIPIENT_EVM);
    }

    /// @notice Same burn for a destination whose recipients are full 32-byte
    ///         values (Sui, Aptos and the like). Works only for domains the owner
    ///         enabled with the RAW32 recipient kind; no such domain exists until
    ///         the owner enables one. Nothing checks the 32 bytes beyond
    ///         non-zero, so the caller must give the destination's own format.
    function burnUSDCToBytes32(uint256 amount, bytes32 recipient, uint32 destinationDomain)
        external
        whenNotPaused(Rail.CCTP)
    {
        _burnUSDC(amount, recipient, destinationDomain, RECIPIENT_RAW32);
    }

    function _burnUSDC(uint256 amount, bytes32 mintRecipient, uint32 destinationDomain, uint8 requiredKind) internal {
        // Ordered before any balance/precompile touch so the guards are
        // exact-revert-testable on a simulated EVM (no Rome precompiles).
        // An enabled domain is never 5 (`enableCctpDomain` refuses it), so a
        // burn to Solana's domain fails here as an unsupported domain.
        CctpDest memory dest = _cctpDest[destinationDomain];
        bytes32 remoteTokenMessenger = dest.remoteTokenMessenger;
        if (remoteTokenMessenger == bytes32(0)) {
            revert UnsupportedDestinationDomain(destinationDomain);
        }
        uint8 domainKind = dest.kind;
        if (domainKind != requiredKind) {
            revert RecipientKindMismatch(destinationDomain, domainKind, requiredKind);
        }
        if (mintRecipient == bytes32(0)) {
            revert ZeroRecipient();
        }
        if (amount > type(uint64).max) {
            revert AmountExceedsUint64(amount);
        }
        address user = _msgSender();
        uint256 balance = usdcWrapper.balanceOf(user);
        if (balance < amount) {
            revert InsufficientBalance(user, amount, balance);
        }

        // Canonical user-ATA derivation, post-0acabea (unified PDA model).
        // Avoids the legacy `_accounts` cache in SPL_ERC20 which is empty on
        // a freshly-deployed wrapper — `wrapper.getAta(user)` would return
        // `bytes32(0)` and CCTP's deposit_for_burn would revert with
        // Anchor `AccountOwnedByWrongProgram` (3007) on burn_token_account.
        // Uses the `derive_user_ata` precompile shortcut: one syscall vs the
        // 2× findPda chain in `UserPda.ata` (~80k CU saved per call).
        bytes32 userAta = HelperProgram.ata(user, usdcMint);

        // A direct CALL signs as the bridge, not the user, so CCTP's `owner`
        // must be an account the bridge actually owns. The bridge pulls
        // `amount` into its own ATA (the user grants the delegate once,
        // off-contract, via `approve_spl(bridge, …)` to 0xff..09) and burns
        // from there as the true owner — this holds regardless of whether
        // CCTP would also have accepted the bridge as a mere delegate on the
        // user's own ATA.
        bytes32 bridgePda = RomeEVMAccount.pda(address(this));
        bytes32 bridgeAta = HelperProgram.ata(address(this), usdcMint);
        _pullToBridge(userAta, bridgeAta, amount, usdcMint);

        // The bridge PDA is `event_rent_payer`/`owner`. Its rent for the
        // per-burn messageSentEventData account (cctpMessageRentLamports) is
        // funded from the operator and billed to the user by _fundMessageRent
        // right before the CPI below. Circle's rent stays reclaimable
        // (`reclaimEventAccount`, signed by `event_rent_payer`); nothing here
        // calls it yet.
        // Per-tx message data account derived as a salted PDA under the bridge.
        // Salt includes per-user nonce instead of block.number — block.number on
        // Rome EVM = Solana slot, unstable across emulation/execution.
        uint64 nonce = burnNonce[user];
        burnNonce[user] = nonce + 1;
        // user + address(this) + nonce: user discriminates across accounts (the
        // nonce alone is per-user, not global), address(this) keeps redeploys
        // from colliding with previously-used event-data PDAs.
        bytes32 cctpSalt = keccak256(abi.encodePacked("CCTP_MSG", address(this), user, nonce));
        bytes32 messageSentEventData = RomeEVMAccount.pda_with_salt(address(this), cctpSalt);

        bytes memory ixData = CCTPV2Lib.encodeDepositForBurn(CCTPV2Lib.DepositForBurnParams({
            amount:              uint64(amount),
            destinationDomain:   destinationDomain,
            mintRecipient:       mintRecipient,
            // bytes32(0) = permissionless delivery — anyone (incl. the user
            // via Circle's portal) can submit the destination mint; matches
            // the inbound leg's choice and keeps stuck-transfer rescue open.
            destinationCaller:   bytes32(0),
            // Standard finality is free per Circle's fee schedule; the fast
            // tier (1000) costs bps. maxFee=0 makes any fee-charging path
            // revert rather than silently shave the user's amount.
            maxFee:              0,
            minFinalityThreshold: CCTPV2Lib.MIN_FINALITY_STANDARD
        }));

        // v2-only account: per-owner denylist PDA
        // (["denylist_account", owner] under the v2 TMM). Keyed on the
        // bridge PDA now — it's `owner` below, not the user. Derived at
        // runtime — one find_program_address round-trip (~115K CU).
        ISystemProgram.Seed[] memory denylistSeeds = new ISystemProgram.Seed[](2);
        denylistSeeds[0] = ISystemProgram.Seed(bytes("denylist_account"));
        denylistSeeds[1] = ISystemProgram.Seed(abi.encodePacked(bridgePda));
        (bytes32 denylistAccount, ) = PdaDeriver.derive(cctpTokenMessengerProgram, denylistSeeds);

        ICrossProgramInvocation.AccountMeta[] memory metas =
            CCTPV2Lib.buildDepositForBurnAccounts(
                CCTPV2Lib.DepositForBurnAccounts({
                    owner:                       bridgePda,
                    eventRentPayer:              bridgePda,
                    senderAuthorityPda:          cctpSenderAuthorityPda,
                    burnTokenAccount:            bridgeAta,
                    denylistAccount:             denylistAccount,
                    messageTransmitter:          cctpMessageTransmitterConfig,
                    tokenMessenger:              cctpTokenMessengerConfig,
                    remoteTokenMessenger:        remoteTokenMessenger,
                    tokenMinter:                 cctpTokenMinter,
                    localToken:                  cctpLocalTokenUsdc,
                    burnTokenMint:               usdcMint,
                    messageSentEventData:        messageSentEventData,
                    messageTransmitterProgram:   cctpMessageTransmitterProgram,
                    tokenMessengerMinterProgram: cctpTokenMessengerProgram,
                    tokenProgram:                cctpSplTokenProgram,
                    systemProgram:               cctpSystemProgram,
                    eventAuthority:              cctpEventAuthority,
                    program:                     cctpTokenMessengerProgram,
                    messageTransmitterEventAuthority: cctpMessageTransmitterEventAuthority
                })
            );

        // [0] = cctpSalt, signing the per-tx messageSentEventData PDA. The
        // bridge's own PDA at `owner`/`eventRentPayer` is auto-signed by the
        // precompile from the tx caller (the bridge, under a direct CALL).
        bytes32[] memory salts = new bytes32[](1);
        salts[0] = cctpSalt;

        _fundMessageRent(cctpMessageRentLamports);
        (bool ok, bytes memory result) = address(CpiProgram).call(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                cctpTokenMessengerProgram,
                metas,
                ixData,
                salts
            )
        );
        if (!ok) revert CpiFailed(result);

        if (requiredKind == RECIPIENT_EVM) {
            // Legacy event kept byte-compatible for existing indexers; the
            // domain-carrying variant is the multi-destination source of truth.
            address evmRecipient = address(uint160(uint256(mintRecipient)));
            emit Withdrawn(user, usdcMint, amount, evmRecipient, 0);
            emit WithdrawnToDomain(user, usdcMint, amount, evmRecipient, 0, destinationDomain);
        } else {
            // A 32-byte recipient does not fit the address-typed events above.
            emit WithdrawnToDomainRaw(user, usdcMint, amount, mintRecipient, 0, destinationDomain);
        }
    }

    // -------------------------------------------------------------------------
    // Wormhole path — path=1
    // -------------------------------------------------------------------------

    // `burnETH` (v1-v12) is gone: it sent one hard-wired wETH route to one
    // fixed Wormhole chain. `burnToWormhole` does the same for wETH, and for any
    // other allowed asset and chain.

    /// @notice Pulls `amount` of `mint` from `fromAta` into the bridge's own
    ///         `toAta`, signing as the bridge's own PDA. Succeeds only if the
    ///         bridge is `fromAta`'s owner or SPL delegate — the latter is
    ///         what an EOA's prior `approve_spl(bridge, …)` grants.
    /// @dev A direct CALL into a mutating precompile signs as the bridge
    ///      itself, never the user, so the bridge cannot burn straight from
    ///      the user's ATA as its owner. The user grants the bridge an SPL
    ///      delegate once, off-contract (`approve_spl(bridge, …)` sent directly
    ///      to 0xff..09); every egress rail pulls exactly `amount` into the
    ///      bridge's own ATA first and acts from there as its true owner.
    function _pullToBridge(bytes32 fromAta, bytes32 toAta, uint256 amount, bytes32 mint) private {
        (bool ok, bytes memory result) = address(HelperProgram).call(
            abi.encodeWithSignature(
                "transfer_spl(bytes32,bytes32,uint64,bytes32)",
                fromAta, toAta, uint64(amount), mint
            )
        );
        if (!ok) revert CpiFailed(result);
    }

    /// @notice Grants Wormhole's `authority_signer` PDA an SPL delegate over
    ///         the bridge's own `ata`, signing as the bridge itself (its own
    ///         account, so this needs no borrowed authority). Re-granted on
    ///         every burn since `ata` is now a shared account, not a
    ///         per-user one that could be approved once and left standing.
    function _approveWormholeDelegate(bytes32 ata, uint256 amount, bytes32 mint, uint8 decimals) private {
        (bool ok, bytes memory result) = address(HelperProgram).call(
            abi.encodeWithSignature(
                "approve_spl_raw_delegate(bytes32,bytes32,uint64,bytes32,uint8)",
                ata, wormholeAuthoritySigner, uint64(amount), mint, decimals
            )
        );
        if (!ok) revert CpiFailed(result);
    }

    /// @notice Generic (asset-agnostic, multi-destination) Wormhole burn —
    ///         the per-asset + per-call-target Wormhole egress (it replaces `burnETH`).
    ///         Burns `amount` of the asset behind `assetWrapper` and initiates
    ///         a Wormhole `transfer_wrapped` CPI to (`targetChain`, `recipient`).
    ///         The mint + `wrapped_meta` are derived from the wrapper at runtime
    ///         (no per-asset immutables). The caller must have granted the bridge an SPL
    ///         delegate on their ATA beforehand (`approve_spl(bridge, …)` sent
    ///         directly to 0xff..09) — see `_pullToBridge` for why.
    ///         Destination claim is Wormhole-native (user redeems the VAA).
    /// @param assetWrapper Registered SPL_ERC20 wrapper for the asset.
    /// @param amount       Token amount in the wrapper's SPL decimals (uint64-bounded).
    /// @param recipient    32-byte recipient on target chain (EVM addr left-padded; Solana pubkey raw).
    /// @param targetChain  Wormhole chain id, PER-CALL (must be allowlisted).
    function burnToWormhole(
        address assetWrapper,
        uint256 amount,
        bytes32 recipient,
        uint16 targetChain
    ) external whenNotPaused(Rail.WORMHOLE) {
        // Guards ordered BEFORE any Rome precompile touch, so their exact
        // reverts are assertable on a simulated EVM (parity with _burnUSDC).
        if (!wormholeMintAllowed[SPL_ERC20(assetWrapper).mint_id()]) {
            revert UnsupportedAssetWrapper(assetWrapper);
        }
        if (!wormholeTargetChainAllowed[targetChain]) {
            revert UnsupportedTargetChain(targetChain);
        }
        if (recipient == bytes32(0)) {
            revert ZeroRecipient();
        }
        if (amount > type(uint64).max) {
            revert AmountExceedsUint64(amount);
        }

        SPL_ERC20 wrapper = SPL_ERC20(assetWrapper);
        bytes32 mint = wrapper.mint_id();
        address user = _msgSender();
        uint256 balance = wrapper.balanceOf(user);
        if (balance < amount) {
            revert InsufficientBalance(user, amount, balance);
        }

        uint8 decimals = wrapper.decimals();
        bytes32 bridgePda = RomeEVMAccount.pda(address(this));
        bytes32 userAta = HelperProgram.ata(user, mint);
        bytes32 bridgeAta = HelperProgram.ata(address(this), mint);

        _pullToBridge(userAta, bridgeAta, amount, mint);
        _approveWormholeDelegate(bridgeAta, amount, mint, decimals);

        // wrapped_meta = ["meta", mint] PDA under the Token Bridge — derived
        // per-asset at runtime (v12 had a wethMint-specific immutable). Same
        // runtime-derivation pattern as _burnUSDC's denylist PDA.
        ISystemProgram.Seed[] memory metaSeeds = new ISystemProgram.Seed[](2);
        metaSeeds[0] = ISystemProgram.Seed(bytes("meta"));
        metaSeeds[1] = ISystemProgram.Seed(abi.encodePacked(mint));
        (bytes32 wrappedMeta, ) = PdaDeriver.derive(wormholeTokenBridgeProgram, metaSeeds);

        // Per-tx Wormhole message account: salted PDA under the bridge (nonce, not
        // block.number — unstable across emulation/execution on Rome).
        uint64 nonce = burnNonce[user];
        burnNonce[user] = nonce + 1;
        bytes32 whSalt = keccak256(abi.encodePacked("WH_MSG", address(this), user, nonce));
        bytes32 messageAccount = RomeEVMAccount.pda_with_salt(address(this), whSalt);

        bytes memory ixData = WormholeTokenBridgeLib.encodeTransferTokens(
            WormholeTokenBridgeLib.TransferParams({
                amount:        uint64(amount),
                fee:           0,
                targetAddress: recipient,
                targetChain:   targetChain,
                nonce:         uint32(block.timestamp)
            })
        );

        ICrossProgramInvocation.AccountMeta[] memory metas =
            WormholeTokenBridgeLib.buildTransferWrappedAccounts(
                WormholeTokenBridgeLib.TransferWrappedAccounts({
                    payer:            bridgePda,
                    config:           wormholeConfig,
                    from:             bridgeAta,
                    from_owner:       bridgePda,
                    mint:             mint,
                    wrapped_meta:     wrappedMeta,
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
                    token:            whSplTokenProgram,
                    token_bridge_program: wormholeTokenBridgeProgram
                })
            );

        bytes32[] memory salts = new bytes32[](1);
        salts[0] = whSalt;

        _fundMessageRent(wormholeMessageRentLamports);
        (bool ok, bytes memory result) = address(CpiProgram).call(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                wormholeTokenBridgeProgram,
                metas,
                ixData,
                salts
            )
        );
        if (!ok) revert CpiFailed(result);

        emit WormholeBurn(user, assetWrapper, mint, amount, recipient, targetChain);
    }

    // -------------------------------------------------------------------------
    // Wormhole transfer_native — Solana-native mint egress (wSOL, mSOL, LSTs)
    // -------------------------------------------------------------------------

    /// @notice Solana-native counterpart of `burnToWormhole`. Where
    ///         `burnToWormhole` uses transfer_wrapped (for Wormhole-origin assets
    ///         like wETH), this uses **transfer_native** (solitaire tag 5) so a
    ///         Solana-native mint (wSOL, mSOL, LSTs) egresses via Wormhole: the
    ///         tokens move into the Token Bridge's per-mint custody and a transfer
    ///         VAA is posted; the recipient redeems on the target chain.
    /// @dev The caller must have granted the bridge an SPL delegate on their
    ///      ATA beforehand (`approve_spl(bridge, …)` sent directly to
    ///      0xff..09) — see `_pullToBridge` for why.
    /// @param assetWrapper Registered SPL_ERC20 wrapper for a Solana-native mint.
    /// @param amount       Token amount in the wrapper's SPL decimals (uint64-bounded).
    /// @param recipient    32-byte recipient on the target chain (non-zero).
    /// @param targetChain  Wormhole chain id, PER-CALL (must be allowlisted).
    function transferNativeToWormhole(
        address assetWrapper,
        uint256 amount,
        bytes32 recipient,
        uint16 targetChain
    ) external whenNotPaused(Rail.WORMHOLE) {
        // Guards ordered BEFORE any Rome precompile touch (parity with burnToWormhole).
        if (!wormholeMintAllowed[SPL_ERC20(assetWrapper).mint_id()]) {
            revert UnsupportedAssetWrapper(assetWrapper);
        }
        if (!wormholeTargetChainAllowed[targetChain]) {
            revert UnsupportedTargetChain(targetChain);
        }
        if (recipient == bytes32(0)) {
            revert ZeroRecipient();
        }
        if (amount > type(uint64).max) {
            revert AmountExceedsUint64(amount);
        }

        SPL_ERC20 wrapper = SPL_ERC20(assetWrapper);
        bytes32 mint = wrapper.mint_id();
        address user = _msgSender();
        uint256 balance = wrapper.balanceOf(user);
        if (balance < amount) {
            revert InsufficientBalance(user, amount, balance);
        }

        uint8 decimals = wrapper.decimals();
        // transfer_native normalizes to min(decimals, 8); the pull-first shape
        // moves the SPL out of the user's ATA before that truncation happens,
        // so any sub-8-decimal remainder would strand in the bridge's own ATA
        // (pre-migration it stayed recoverable in the user's own ATA). Reject
        // up front rather than create unreachable residue.
        if (decimals > 8) {
            uint256 granularity = 10 ** (decimals - 8);
            if (amount % granularity != 0) {
                revert SubGranularityAmount(amount, granularity);
            }
        }
        bytes32 bridgePda = RomeEVMAccount.pda(address(this));
        bytes32 userAta = HelperProgram.ata(user, mint);
        bytes32 bridgeAta = HelperProgram.ata(address(this), mint);

        _pullToBridge(userAta, bridgeAta, amount, mint);
        _approveWormholeDelegate(bridgeAta, amount, mint, decimals);

        // custody = ["<mint>"] PDA under the Token Bridge — PER-MINT, derived at
        // runtime. THE crux: v10's single stored custody account served ONE mint
        // only; native egress of multiple mints requires per-mint custody. Matches
        // @wormhole-foundation/sdk-solana-tokenbridge deriveCustodyKey =
        // deriveAddress([mint], tokenBridge). custody_signer is global (stored).
        ISystemProgram.Seed[] memory custodySeeds = new ISystemProgram.Seed[](1);
        custodySeeds[0] = ISystemProgram.Seed(abi.encodePacked(mint));
        (bytes32 custody, ) = PdaDeriver.derive(wormholeTokenBridgeProgram, custodySeeds);

        // Per-tx Wormhole message account: salted PDA under the bridge (nonce, not
        // block.number — unstable across emulation/execution on Rome).
        uint64 nonce = burnNonce[user];
        burnNonce[user] = nonce + 1;
        bytes32 whSalt = keccak256(abi.encodePacked("WH_MSG", address(this), user, nonce));
        bytes32 messageAccount = RomeEVMAccount.pda_with_salt(address(this), whSalt);

        bytes memory ixData = WormholeTokenBridgeLib.encodeTransferNative(
            WormholeTokenBridgeLib.TransferParams({
                amount:        uint64(amount),
                fee:           0,
                targetAddress: recipient,
                targetChain:   targetChain,
                nonce:         uint32(block.timestamp)
            })
        );

        ICrossProgramInvocation.AccountMeta[] memory metas =
            WormholeTokenBridgeLib.buildTransferNativeAccounts(
                WormholeTokenBridgeLib.TransferNativeAccounts({
                    payer:            bridgePda,
                    config:           wormholeConfig,
                    from:             bridgeAta,
                    mint:             mint,
                    custody:          custody,
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
                    wormhole_core:    wormholeCoreProgram,
                    token_bridge_program: wormholeTokenBridgeProgram
                })
            );

        // Only the per-tx message PDA needs an explicit signing salt; the
        // bridge's own PDA at `payer` is auto-signed by the precompile from
        // the tx caller (the bridge, under a direct CALL). Native has no
        // from_owner — the from→custody move is authorized by the
        // authority_signer delegation granted just above, on the bridge's ATA.
        bytes32[] memory salts = new bytes32[](1);
        salts[0] = whSalt;

        _fundMessageRent(wormholeMessageRentLamports);
        (bool ok, bytes memory result) = address(CpiProgram).call(
            abi.encodeWithSignature(
                "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])",
                wormholeTokenBridgeProgram,
                metas,
                ixData,
                salts
            )
        );
        if (!ok) revert CpiFailed(result);

        emit WormholeNativeTransfer(user, assetWrapper, mint, amount, recipient, targetChain);
    }

    // -------------------------------------------------------------------------
    // Rome → Solana SPL egress (any wrapper mint)
    //
    // Two atomic single-CPI txs — `ensureRecipientAta` (only when the recipient
    // lacks the ATA) then transfer-only `bridgeOutToSolana` — keep each Rome
    // DoTx within the 1.4M-CU budget AND avoid the iterative-VM
    // `CpiProhibitedInIterativeTx` gate that the old combined 2-CPI
    // bridge-out tripped. Legacy track (HelperProgram), consistent with
    // burnUSDC. See contracts/bridge/SOLANA_EGRESS_DESIGN.md.
    // -------------------------------------------------------------------------

    /// @notice Transfer-only Rome → Solana egress of any held SPL wrapper to a
    ///         raw Solana recipient. Source = caller's own ATA for `mint`;
    ///         destination = `ata(solanaRecipient, mint)`, which MUST already
    ///         exist (call `ensureRecipientAta` first when uncertain — SPL
    ///         transfer_checked does not create the destination). The caller
    ///         must have granted the bridge an SPL delegate on their ATA
    ///         beforehand (`approve_spl(bridge, …)` sent directly to 0xff..09).
    /// @param solanaRecipient Recipient Solana wallet pubkey (bytes32, non-zero).
    /// @param amount          Token amount in the wrapper's SPL decimals (uint64-bounded).
    /// @param mint            The wrapper's underlying SPL mint.
    function bridgeOutToSolana(
        bytes32 solanaRecipient,
        uint256 amount,
        bytes32 mint
    ) external whenNotPaused(Rail.TO_SOLANA) {
        if (amount > type(uint64).max) {
            revert AmountExceedsUint64(amount);
        }
        if (solanaRecipient == bytes32(0)) {
            revert ZeroRecipient();
        }
        address user = _msgSender();

        // Recipient ATA = getATA(recipientWallet, mint) — derived read (EthCall,
        // track-neutral, never locks the tx track).
        bytes32 toAta = UserPda.ataForKey(solanaRecipient, mint);
        bytes32 fromAta = HelperProgram.ata(user, mint);

        // Direct CALL: signs as external_auth(bridge), which SPL Token
        // accepts as either owner or delegate of `fromAta` — the caller's
        // prior `approve_spl(bridge, …)` grant makes it the latter.
        (bool ok, bytes memory result) = address(HelperProgram).call(
            abi.encodeWithSignature(
                "transfer_spl(bytes32,bytes32,uint64,bytes32)",
                fromAta,
                toAta,
                uint64(amount),
                mint
            )
        );
        if (!ok) revert CpiFailed(result);

        emit BridgedOutToSolana(user, mint, amount, solanaRecipient);
    }

    /// @notice Idempotently create the recipient's ATA for `mint` on Solana so a
    ///         subsequent transfer-only `bridgeOutToSolana` lands. Separate tx
    ///         by design: one CPI, atomic — never trips the iterative-VM gate.
    ///         Permissionless with an arbitrary `(recipient, mint)` — the caller
    ///         pays no Rome-side fee for the operator-funded rent this commits.
    ///         Since it spends operator rent for anyone, it sits behind the
    ///         to-Solana pause: pausing that rail stops a rent-drain loop.
    /// @param solanaRecipient Recipient Solana wallet pubkey (bytes32, non-zero).
    /// @param mint            The wrapper's underlying SPL mint.
    function ensureRecipientAta(bytes32 solanaRecipient, bytes32 mint) external whenNotPaused(Rail.TO_SOLANA) {
        if (solanaRecipient == bytes32(0)) {
            revert ZeroRecipient();
        }
        (bool ok, bytes memory result) = address(HelperProgram).delegatecall(
            abi.encodeWithSignature(
                "create_ata_for_key(bytes32,bytes32)",
                solanaRecipient,
                mint
            )
        );
        if (!ok) revert CpiFailed(result);
    }

    /// @notice Idempotently create the bridge's own ATA for `mint`. Owner-only
    ///         deploy-time bootstrap — no caller-side purpose, and unlike
    ///         `ensureRecipientAta` it spends the OPERATOR's rent
    ///         (`create_ata_for_key` pays from `state.signer()`), so it must
    ///         not be callable by anyone for an arbitrary mint.
    ///         `transfer_spl_from_ata` has no create leg — every mint the
    ///         bridge egresses needs this run once (deploy-time, per mint)
    ///         before its first burn.
    /// @dev Direct CALL, not delegatecall: `create_ata_for_key` ignores
    ///      `context.caller` (owner is the explicit arg, payer is the
    ///      precompile's own signer, seeds empty), so a direct CALL is
    ///      behaviourally identical here and passes the gate on
    ///      `owner_authenticated()` rather than the delegatecall exemption list.
    /// @param mint The wrapper's underlying SPL mint.
    function ensureBridgeAta(bytes32 mint) external onlyOwner {
        (bool ok, bytes memory result) = address(HelperProgram).call(
            abi.encodeWithSignature(
                "create_ata_for_key(bytes32,bytes32)",
                RomeEVMAccount.pda(address(this)),
                mint
            )
        );
        if (!ok) revert CpiFailed(result);
    }

    // -------------------------------------------------------------------------
    // ERC2771Context override
    // -------------------------------------------------------------------------

    function _contextSuffixLength() internal pure override returns (uint256) {
        return 20;
    }
}
