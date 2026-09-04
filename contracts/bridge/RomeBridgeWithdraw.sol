// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
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
///                     per-call destination domain (v6). v2 is required for
///                     v2-only destinations (Monad = 15) and is the
///                     go-forward protocol for every destination.
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
    // wethDecimals cached at construction (read from `_weth.decimals()` which
    // is set as immutable on the SPL_ERC20 wrapper). Used by `burnETH` to
    // feed SPL approve_checked through HelperProgram.approve_spl_raw_delegate
    // without an on-chain mint read at each call.
    uint8 public immutable wethDecimals;

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
    bytes32 public immutable wormholeCustody;
    bytes32 public immutable wormholeAuthoritySigner;
    bytes32 public immutable wormholeCustodySigner;
    bytes32 public immutable wormholeBridgeConfig;
    bytes32 public immutable wormholeFeeCollector;
    bytes32 public immutable wormholeEmitter;
    bytes32 public immutable wormholeSequence;
    bytes32 public immutable wormholeWrappedMeta;
    /// @notice Wormhole destination chain id for outbound ETH transfers.
    /// @dev Set at construction per deploy-network. Wormhole chain ids are
    ///      distinct on mainnet and testnet: Ethereum mainnet = 2, Sepolia =
    ///      10002. Keeping this as a constructor param lets the same contract
    ///      bytecode deploy to testnet or mainnet without touching the source.
    uint16 public immutable wormholeTargetChain;

    // -------------------------------------------------------------------------
    // Per-user nonce for transient message PDAs
    // -------------------------------------------------------------------------

    /// @notice CCTP destination allowlist: Circle domain → remote_token_messenger
    ///         PDA (["remote_token_messenger", dec(domain)] under the v2 TMM).
    ///         Populated once at construction from registry-fed deploy config —
    ///         doubling as the per-destination account CCTP requires AND the
    ///         fat-finger guard (unlisted domain burns revert instead of
    ///         producing an unredeemable message).
    mapping(uint32 => bytes32) public cctpRemoteTokenMessengers;

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
    ///         reverts. Populated once at construction from deploy config;
    ///         mirrors `cctpRemoteTokenMessengers`' dual role (config + guard).
    mapping(uint16 => bool) public wormholeTargetChainAllowed;

    /// @notice Generic-Wormhole asset allowlist, keyed on the SPL MINT (not the
    ///         wrapper instance). All ERC20-SPL wrappers over one mint are fungible
    ///         views of the same on-chain ATA, so keying on the mint accepts any
    ///         wrapper over an allowed asset and kills the multi-wrapper drift
    ///         class. The public API stays wrapper-typed via the
    ///         `wormholeAssetAllowed(address)` view below — callers are unchanged.
    mapping(bytes32 => bool) public wormholeMintAllowed;

    /// @notice Admin of the Wormhole allowlist setters. Seeded at construction
    ///         from `WormholeGenericConfig.admin`; transferable (cold-ledger
    ///         handover, matching this repo's mainnet admin pattern). The ctor
    ///         allowlist is a SEED — the owner enables further assets/chains on
    ///         the live contract (no redeploy per addition). Only gates the two
    ///         allowlist setters + ownership transfer; every value path
    ///         (burnUSDC/burnETH/burnToWormhole/bridgeOutToSolana) is
    ///         permissionless and unaffected.
    address public owner;

    modifier onlyOwner() {
        if (_msgSender() != owner) revert NotOwner(_msgSender());
        _;
    }

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------
    error AmountExceedsUint64(uint256 amount);
    error InsufficientBalance(address user, uint256 requested, uint256 available);
    error CpiFailed(bytes reason);
    error UnsupportedDestinationDomain(uint32 domain);
    error DomainConfigLengthMismatch();
    error ZeroRecipient();
    error UnsupportedTargetChain(uint16 targetChain);
    error UnsupportedAssetWrapper(address assetWrapper);
    error NotOwner(address caller);
    error ZeroOwner();
    error SubGranularityAmount(uint256 amount, uint256 granularity);

    // -------------------------------------------------------------------------
    // Admin events
    // -------------------------------------------------------------------------
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event WormholeAssetAllowedSet(address indexed assetWrapper, bool allowed);
    event WormholeTargetChainAllowedSet(uint16 indexed targetChain, bool allowed);

    // -------------------------------------------------------------------------
    // Constructor params structs (avoids stack-too-deep with many constructor args)
    // -------------------------------------------------------------------------

    /// @notice CCTP-path Solana accounts. Includes all program IDs and PDAs needed
    ///         for the deposit_for_burn CPI. All fields come from the deploy script.
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
        // PDAs — derived per-deployment in Phase 1.5
        bytes32 messageTransmitterConfig;
        bytes32 tokenMessengerConfig;
        bytes32 tokenMinter;
        bytes32 localTokenUsdc;
        /// @dev Destination allowlist, parallel arrays: Circle domain ids and
        ///      their ["remote_token_messenger", dec(domain)] PDAs under the
        ///      v2 TMM. Derived by the deploy script per network.
        uint32[] domains;
        bytes32[] remoteTokenMessengers;
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
        uint16 targetChain;       // Wormhole destination chain id: 2 mainnet ETH, 10002 Sepolia
    }

    /// @notice Generic-Wormhole config: per-call target-chain allowlist +
    ///         registered asset wrappers. Enables asset-agnostic +
    ///         multi-destination Wormhole egress (`burnToWormhole`), closing
    ///         the inbound⇒outbound symmetry for non-ETH assets (LSTs etc.).
    ///         Independent of the legacy ETH-only `burnETH` path (which keeps
    ///         its own immutables); nothing is allowed unless listed here.
    struct WormholeGenericConfig {
        address admin;            // owner of the post-deploy allowlist setters (see `owner`)
        uint16[] targetChains;    // Wormhole chain ids allowed as burnToWormhole destinations
        address[] assetWrappers;  // SPL_ERC20 wrappers allowed as burnToWormhole assets
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    constructor(
        address forwarder,
        SPL_ERC20 _usdc,
        SPL_ERC20 _weth,
        CctpParams memory cctp,
        WormholeParams memory wh,
        WormholeGenericConfig memory whg
    ) ERC2771Context(forwarder) {
        usdcWrapper = _usdc;
        wethWrapper = _weth;
        usdcMint = _usdc.mint_id();
        wethMint = _weth.mint_id();
        wethDecimals = _weth.decimals();
        // CCTP
        cctpTokenMessengerProgram     = cctp.tokenMessengerProgram;
        cctpMessageTransmitterProgram = cctp.messageTransmitterProgram;
        cctpSplTokenProgram           = cctp.splTokenProgram;
        cctpSystemProgram             = cctp.systemProgram;
        cctpMessageTransmitterConfig  = cctp.messageTransmitterConfig;
        cctpTokenMessengerConfig      = cctp.tokenMessengerConfig;
        cctpTokenMinter               = cctp.tokenMinter;
        if (cctp.domains.length != cctp.remoteTokenMessengers.length) {
            revert DomainConfigLengthMismatch();
        }
        for (uint256 i = 0; i < cctp.domains.length; i++) {
            cctpRemoteTokenMessengers[cctp.domains[i]] = cctp.remoteTokenMessengers[i];
        }
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
        wormholeCustody            = wh.custody;
        wormholeAuthoritySigner    = wh.authoritySigner;
        wormholeCustodySigner      = wh.custodySigner;
        wormholeBridgeConfig       = wh.bridgeConfig;
        wormholeFeeCollector       = wh.feeCollector;
        wormholeEmitter            = wh.emitter;
        wormholeSequence           = wh.sequence;
        wormholeWrappedMeta        = wh.wrappedMeta;
        wormholeTargetChain        = wh.targetChain;
        // Generic-Wormhole allowlists (asset-agnostic + multi-destination egress).
        // Fail-closed SEED: only chains/wrappers listed here can burnToWormhole
        // until `owner` lists more via the setters below.
        if (whg.admin == address(0)) revert ZeroOwner();
        owner = whg.admin;
        emit OwnershipTransferred(address(0), whg.admin);
        for (uint256 i = 0; i < whg.targetChains.length; i++) {
            wormholeTargetChainAllowed[whg.targetChains[i]] = true;
        }
        for (uint256 i = 0; i < whg.assetWrappers.length; i++) {
            wormholeMintAllowed[SPL_ERC20(whg.assetWrappers[i]).mint_id()] = true;
        }
    }

    // -------------------------------------------------------------------------
    // Admin: post-deploy Wormhole allowlist management
    // -------------------------------------------------------------------------

    /// @notice Enable/disable an SPL_ERC20 wrapper as a `burnToWormhole` asset.
    ///         Lets the owner add wmSOL / arb / avax (etc.) on the LIVE contract
    ///         — the reason v8 exists (v7's allowlist was constructor-frozen).
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

    /// @notice Transfer allowlist-admin ownership (cold-ledger handover). Reverts
    ///         on the zero address so admin can't be accidentally burned.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroOwner();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // -------------------------------------------------------------------------
    // CCTP path — path=0
    // -------------------------------------------------------------------------

    /// @notice Back-compat overload: burns to the Ethereum-family domain (0).
    ///         Same ABI the Rome app's live hook calls today; routes through the
    ///         v2 path like every other destination.
    function burnUSDC(uint256 amount, address ethereumRecipient) external {
        _burnUSDC(amount, ethereumRecipient, 0);
    }

    /// @notice Burns wUSDC on the Rome EVM and initiates a CCTP **v2**
    ///         deposit_for_burn CPI on Solana, bridging to `recipient` on the
    ///         EVM chain identified by `destinationDomain` (Circle domain id:
    ///         Ethereum/Sepolia 0, Avalanche 1, Arbitrum 3, Base 6, Polygon 7,
    ///         Monad 15). The domain must be in the constructor allowlist.
    /// @param amount            Token amount in SPL decimals (must fit uint64).
    /// @param recipient         Destination address on the target EVM chain.
    /// @param destinationDomain Circle CCTP domain of the destination chain.
    function burnUSDC(uint256 amount, address recipient, uint32 destinationDomain) external {
        _burnUSDC(amount, recipient, destinationDomain);
    }

    function _burnUSDC(uint256 amount, address ethereumRecipient, uint32 destinationDomain) internal {
        // Ordered before any balance/precompile touch so both guards are
        // exact-revert-testable on a simulated EVM (no Rome precompiles).
        bytes32 remoteTokenMessenger = cctpRemoteTokenMessengers[destinationDomain];
        if (remoteTokenMessenger == bytes32(0)) {
            revert UnsupportedDestinationDomain(destinationDomain);
        }
        // Domain 5 (Solana) is structurally unsupported by this address-typed
        // API: mintRecipient is a left-padded EVM address, not a valid Solana
        // token account, so a burn to domain 5 would be unredeemable. Fail
        // closed even if a deployment mistakenly maps domain 5.
        if (destinationDomain == CCTPV2Lib.DOMAIN_SOLANA) {
            revert UnsupportedDestinationDomain(destinationDomain);
        }
        if (ethereumRecipient == address(0)) {
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

        // The bridge PDA is now `event_rent_payer`/`owner` — it must hold
        // ≥ ~13M lamports per burn for CCTP's inner System::create_account
        // on `messageSentEventData`, fronted by the bridge and recouped in
        // gas. Circle's rent IS reclaimable (`reclaimEventAccount`, signed
        // by `event_rent_payer`), but nothing here calls it — a live drain
        // until an operator sweep or a reclaim entry point exists. See
        // contracts/bridge/README.md § "Bridge PDA funding" for the ops
        // requirements this creates.

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
            mintRecipient:       bytes32(uint256(uint160(ethereumRecipient))),
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

        // Legacy event kept byte-compatible for existing indexers; the
        // domain-carrying variant is the multi-destination source of truth.
        emit Withdrawn(user, usdcMint, amount, ethereumRecipient, 0);
        emit WithdrawnToDomain(user, usdcMint, amount, ethereumRecipient, 0, destinationDomain);
    }

    // -------------------------------------------------------------------------
    // Wormhole path — path=1
    // -------------------------------------------------------------------------

    /// @notice Burns rWETH on the Rome EVM and initiates a Wormhole transfer_tokens
    ///         CPI on Solana, bridging funds to `ethereumRecipient` on Ethereum.
    /// @param amount           Token amount in SPL decimals (must fit uint64).
    /// @param ethereumRecipient Destination address on Ethereum.
    /// @dev A direct CALL into a mutating precompile signs as the bridge
    ///      itself, never the user, so the bridge can no longer read straight
    ///      from the user's ATA as its true owner. The user grants the bridge
    ///      an SPL delegate once, off-contract (`approve_spl(bridge, …)` sent
    ///      directly to 0xff..09); this pulls exactly `amount` into the
    ///      bridge's own ATA and burns from there as its actual owner, which
    ///      holds regardless of whether Wormhole would also have tolerated a
    ///      delegate at `from_owner`. Wormhole's own transfer moves tokens via
    ///      its `authority_signer` PDA, not `from_owner` — that delegation is
    ///      re-granted on the bridge's ATA on every call, since it now backs a
    ///      shared account rather than a per-user one.
    function burnETH(uint256 amount, address ethereumRecipient) external {
        // Fail closed on a zero destination, before amount/balance — a
        // bytes32(0) targetAddress produces an unredeemable Wormhole VAA
        // (permanent loss). Mirrors _burnUSDC / burnToWormhole / bridgeOutToSolana.
        if (ethereumRecipient == address(0)) {
            revert ZeroRecipient();
        }
        if (amount > type(uint64).max) {
            revert AmountExceedsUint64(amount);
        }
        address user = _msgSender();
        uint256 balance = wethWrapper.balanceOf(user);
        if (balance < amount) {
            revert InsufficientBalance(user, amount, balance);
        }

        bytes32 bridgePda = RomeEVMAccount.pda(address(this));
        bytes32 userAta = HelperProgram.ata(user, wethMint);
        bytes32 bridgeAta = HelperProgram.ata(address(this), wethMint);

        _pullToBridge(userAta, bridgeAta, amount, wethMint);
        _approveWormholeDelegate(bridgeAta, amount, wethMint, wethDecimals);

        // Per-tx Wormhole message account derived as a salted PDA under the bridge.
        uint64 nonce = burnNonce[user];
        burnNonce[user] = nonce + 1;
        bytes32 whSalt = keccak256(abi.encodePacked("WH_MSG", address(this), user, nonce));
        bytes32 messageAccount = RomeEVMAccount.pda_with_salt(address(this), whSalt);

        bytes memory ixData = WormholeTokenBridgeLib.encodeTransferTokens(
            WormholeTokenBridgeLib.TransferParams({
                amount:        uint64(amount),
                fee:           0,
                targetAddress: bytes32(uint256(uint160(ethereumRecipient))),
                targetChain:   wormholeTargetChain,
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
                    token:            whSplTokenProgram,
                    token_bridge_program: wormholeTokenBridgeProgram
                })
            );

        // [0] = whSalt, signing the per-tx messageAccount PDA. The bridge's
        // own PDA at `payer`/`from_owner` is auto-signed by the precompile
        // from the tx caller (now the bridge itself, under a direct CALL).
        bytes32[] memory salts = new bytes32[](1);
        salts[0] = whSalt;

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

        emit Withdrawn(user, wethMint, amount, ethereumRecipient, 1);
    }

    /// @notice Pulls `amount` of `mint` from `fromAta` into the bridge's own
    ///         `toAta`, signing as the bridge's own PDA. Succeeds only if the
    ///         bridge is `fromAta`'s owner or SPL delegate — the latter is
    ///         what an EOA's prior `approve_spl(bridge, …)` grants.
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
    ///         the per-asset + per-call-target counterpart of `burnETH`.
    ///         Burns `amount` of the asset behind `assetWrapper` and initiates
    ///         a Wormhole `transfer_wrapped` CPI to (`targetChain`, `recipient`).
    ///         The mint + `wrapped_meta` are derived from the wrapper at runtime
    ///         (replacing the wethMint/wormholeWrappedMeta/wormholeTargetChain
    ///         immutables). The caller must have granted the bridge an SPL
    ///         delegate on their ATA beforehand (`approve_spl(bridge, …)` sent
    ///         directly to 0xff..09) — see `burnETH` for why.
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
    ) external {
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
        // per-asset at runtime (was the wethMint-specific immutable). Same
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
    ///      0xff..09) — see `burnETH` for why.
    /// @param assetWrapper Registered SPL_ERC20 wrapper for a Solana-native mint.
    /// @param amount       Token amount in the wrapper's SPL decimals (uint64-bounded).
    /// @param recipient    32-byte recipient on the target chain (non-zero).
    /// @param targetChain  Wormhole chain id, PER-CALL (must be allowlisted).
    function transferNativeToWormhole(
        address assetWrapper,
        uint256 amount,
        bytes32 recipient,
        uint16 targetChain
    ) external {
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
        // runtime. THE crux: v10's single stored `wormholeCustody` serves ONE mint
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
    // burnUSDC/burnETH. See contracts/bridge/SOLANA_EGRESS_DESIGN.md.
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
    ) external {
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
    /// @param solanaRecipient Recipient Solana wallet pubkey (bytes32, non-zero).
    /// @param mint            The wrapper's underlying SPL mint.
    function ensureRecipientAta(bytes32 solanaRecipient, bytes32 mint) external {
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
