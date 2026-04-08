// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {WormholeTokenBridgeEncoding} from "./WormholeTokenBridgeEncoding.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title RomeWormholeBridge
/// @notice Rome EVM adapter: CPI into Wormhole Core, Token Bridge, and SPL Token. Client SDK builds
/// the same `AccountMeta` lists as `wormhole-sdk-ts` for Solana; this contract supplies instruction
/// data helpers and forwards `invoke` (do not call CPI precompiles from application code).
contract RomeWormholeBridge is Ownable, Pausable {
    error EmptyAccounts();

    event BridgeSend(
        address indexed sender,
        bytes32 targetAddress,
        uint16 targetChain,
        uint64 amount,
        uint32 nonce
    );
    event BridgeClaim(
        address indexed claimer,
        bytes32 tokenBridgeProgramId,
        uint256 accountCount
    );

    constructor() Ownable(msg.sender) {}

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Generic CPI invoke. The programId is caller-supplied because the Solana runtime
    /// validates CPI account constraints at execution time — the EVM contract delegates security
    /// to the CPI precompile and the Solana runtime, not to an on-chain allowlist.
    function invoke(bytes32 programId, ICrossProgramInvocation.AccountMeta[] calldata accounts, bytes calldata data)
        external
    {
        _requireNotPaused();
        _invoke(programId, accounts, data);
    }

    /// @notice CPI invoke targeting Wormhole Core. programId is caller-supplied; the Solana runtime
    /// validates that the instruction accounts belong to the given program.
    function invokeWormholeCore(
        bytes32 wormholeCoreProgramId,
        ICrossProgramInvocation.AccountMeta[] calldata accounts,
        bytes calldata data
    ) external {
        _requireNotPaused();
        _invoke(wormholeCoreProgramId, accounts, data);
    }

    /// @notice CPI invoke targeting Token Bridge. programId is caller-supplied; the Solana runtime
    /// validates that the instruction accounts belong to the given program.
    function invokeTokenBridge(
        bytes32 tokenBridgeProgramId,
        ICrossProgramInvocation.AccountMeta[] calldata accounts,
        bytes calldata data
    ) external {
        _requireNotPaused();
        _invoke(tokenBridgeProgramId, accounts, data);
    }

    /// @notice CPI invoke targeting SPL Token. programId is caller-supplied; the Solana runtime
    /// validates that the instruction accounts belong to the given program.
    function invokeSplToken(
        bytes32 splTokenProgramId,
        ICrossProgramInvocation.AccountMeta[] calldata accounts,
        bytes calldata data
    ) external {
        _requireNotPaused();
        _invoke(splTokenProgramId, accounts, data);
    }

    function sendTransferNative(
        bytes32 splTokenProgramId,
        ICrossProgramInvocation.AccountMeta[] calldata approveAccounts,
        uint64 approveAmount,
        bytes32 tokenBridgeProgramId,
        ICrossProgramInvocation.AccountMeta[] calldata transferAccounts,
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain,
        bytes32 messageSalt
    ) external {
        _requireNotPaused();
        _validateSendParams(amount, fee, targetAddress, targetChain);

        _invoke(splTokenProgramId, approveAccounts, _encodeSplApprove(approveAmount));
        _invokeSigned(
            tokenBridgeProgramId,
            transferAccounts,
            WormholeTokenBridgeEncoding.encodeTransferNative(nonce, amount, fee, targetAddress, targetChain),
            messageSalt
        );

        emit BridgeSend(msg.sender, targetAddress, targetChain, amount, nonce);
    }

    function sendTransferWrapped(
        bytes32 splTokenProgramId,
        ICrossProgramInvocation.AccountMeta[] calldata approveAccounts,
        uint64 approveAmount,
        bytes32 tokenBridgeProgramId,
        ICrossProgramInvocation.AccountMeta[] calldata transferAccounts,
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain,
        bytes32 messageSalt
    ) external {
        _requireNotPaused();
        _validateSendParams(amount, fee, targetAddress, targetChain);

        _invoke(splTokenProgramId, approveAccounts, _encodeSplApprove(approveAmount));
        _invokeSigned(
            tokenBridgeProgramId,
            transferAccounts,
            WormholeTokenBridgeEncoding.encodeTransferWrapped(nonce, amount, fee, targetAddress, targetChain),
            messageSalt
        );

        emit BridgeSend(msg.sender, targetAddress, targetChain, amount, nonce);
    }

    function claimCompleteNative(bytes32 tokenBridgeProgramId, ICrossProgramInvocation.AccountMeta[] calldata accounts)
        external
    {
        _requireNotPaused();
        _invoke(tokenBridgeProgramId, accounts, WormholeTokenBridgeEncoding.encodeCompleteNative());

        emit BridgeClaim(msg.sender, tokenBridgeProgramId, accounts.length);
    }

    function claimCompleteWrapped(bytes32 tokenBridgeProgramId, ICrossProgramInvocation.AccountMeta[] calldata accounts)
        external
    {
        _requireNotPaused();
        _invoke(tokenBridgeProgramId, accounts, WormholeTokenBridgeEncoding.encodeCompleteWrapped());

        emit BridgeClaim(msg.sender, tokenBridgeProgramId, accounts.length);
    }

    /// @notice Token Bridge `authority_signer` PDA (delegate target for SPL approve before transfer).
    function authoritySignerPda(bytes32 tokenBridgeProgramId) external pure returns (bytes32) {
        return _authoritySignerPda(tokenBridgeProgramId);
    }

    function bridgeUserPda() external view returns (bytes32) {
        return RomeEVMAccount.pda(msg.sender);
    }

    function encodeTransferNative(
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain
    ) external pure returns (bytes memory) {
        return WormholeTokenBridgeEncoding.encodeTransferNative(nonce, amount, fee, targetAddress, targetChain);
    }

    function encodeTransferWrapped(
        uint32 nonce,
        uint64 amount,
        uint64 fee,
        bytes32 targetAddress,
        uint16 targetChain
    ) external pure returns (bytes memory) {
        return WormholeTokenBridgeEncoding.encodeTransferWrapped(nonce, amount, fee, targetAddress, targetChain);
    }

    function encodeCompleteNative() external pure returns (bytes memory) {
        return WormholeTokenBridgeEncoding.encodeCompleteNative();
    }

    function encodeCompleteWrapped() external pure returns (bytes memory) {
        return WormholeTokenBridgeEncoding.encodeCompleteWrapped();
    }

    function encodeSplTokenApprove(uint64 amount) external pure returns (bytes memory) {
        return _encodeSplApprove(amount);
    }

    function _authoritySignerPda(bytes32 tokenBridgeProgramId) internal pure returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](1);
        seeds[0] = ISystemProgram.Seed(bytes("authority_signer"));
        (bytes32 key,) = SystemProgram.find_program_address(tokenBridgeProgramId, seeds);
        return key;
    }

    /// @dev Validate common send-transfer parameters before CPI.
    function _validateSendParams(uint64 amount, uint64 fee, bytes32 targetAddress, uint16 targetChain) private pure {
        require(amount > 0, "Zero amount");
        require(fee <= amount, "Fee exceeds amount");
        require(targetAddress != bytes32(0), "Invalid target");
        require(targetChain != 0, "Invalid chain");
    }

    /// @dev SPL Token `Approve` instruction (discriminator 4 + u64 amount LE).
    function _encodeSplApprove(uint64 amount) private pure returns (bytes memory) {
        bytes memory out = new bytes(9);
        out[0] = bytes1(uint8(4));
        for (uint256 i = 0; i < 8; i++) {
            out[1 + i] = bytes1(uint8(amount >> (8 * i)));
        }
        return out;
    }

    /// @notice Derive the message PDA that `invoke_signed` will produce for a given salt.
    /// The CPI precompile derives: PDA(["EXTERNAL_AUTHORITY", caller_evm_addr, salt], rome_evm_program).
    /// Clients must derive the same PDA off-chain and include it in `transferAccounts`.
    function deriveMessagePda(bytes32 romeEvmProgramId, bytes32 salt) external view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(bytes("EXTERNAL_AUTHORITY"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(msg.sender));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(salt));
        (bytes32 key,) = SystemProgram.find_program_address(romeEvmProgramId, seeds);
        return key;
    }

    function _invoke(bytes32 programId, ICrossProgramInvocation.AccountMeta[] calldata accounts, bytes memory data)
        internal
    {
        if (accounts.length == 0) revert EmptyAccounts();
        ICrossProgramInvocation.AccountMeta[] memory m = new ICrossProgramInvocation.AccountMeta[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            m[i] = accounts[i];
        }
        // delegatecall preserves msg.sender so the CPI precompile signs
        // for the original caller's PDA, not the bridge contract's PDA.
        (bool ok, bytes memory ret) = address(CpiProgram).delegatecall(
            abi.encodeCall(ICrossProgramInvocation.invoke, (programId, m, data))
        );
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }

    function _invokeSigned(
        bytes32 programId,
        ICrossProgramInvocation.AccountMeta[] calldata accounts,
        bytes memory data,
        bytes32 salt
    ) internal {
        if (accounts.length == 0) revert EmptyAccounts();
        ICrossProgramInvocation.AccountMeta[] memory m = new ICrossProgramInvocation.AccountMeta[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            m[i] = accounts[i];
        }
        bytes32[] memory seeds = new bytes32[](1);
        seeds[0] = salt;
        // delegatecall preserves msg.sender; invoke_signed adds the salt-derived PDA
        // as an additional signer alongside the caller's default PDA.
        (bool ok, bytes memory ret) = address(CpiProgram).delegatecall(
            abi.encodeCall(ICrossProgramInvocation.invoke_signed, (programId, m, data, seeds))
        );
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
}
