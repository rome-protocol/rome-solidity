// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interface.sol";
import {WormholeTokenBridgeEncoding} from "./WormholeTokenBridgeEncoding.sol";
import {RomeEVMAccount} from "../rome_evm_account.sol";

/// @title RomeWormholeBridge
/// @notice Rome EVM adapter: CPI into Wormhole Core, Token Bridge, and SPL Token. Client SDK builds
/// the same `AccountMeta` lists as `wormhole-sdk-ts` for Solana; this contract supplies instruction
/// data helpers and forwards `invoke` (do not call CPI precompiles from application code).
contract RomeWormholeBridge {
    error EmptyAccounts();

    function invoke(bytes32 programId, ICrossProgramInvocation.AccountMeta[] calldata accounts, bytes calldata data)
        external
    {
        _invoke(programId, accounts, data);
    }

    function invokeWormholeCore(
        bytes32 wormholeCoreProgramId,
        ICrossProgramInvocation.AccountMeta[] calldata accounts,
        bytes calldata data
    ) external {
        _invoke(wormholeCoreProgramId, accounts, data);
    }

    function invokeTokenBridge(
        bytes32 tokenBridgeProgramId,
        ICrossProgramInvocation.AccountMeta[] calldata accounts,
        bytes calldata data
    ) external {
        _invoke(tokenBridgeProgramId, accounts, data);
    }

    function invokeSplToken(
        bytes32 splTokenProgramId,
        ICrossProgramInvocation.AccountMeta[] calldata accounts,
        bytes calldata data
    ) external {
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
        uint16 targetChain
    ) external {
        _invoke(splTokenProgramId, approveAccounts, _encodeSplApprove(approveAmount));
        _invoke(
            tokenBridgeProgramId,
            transferAccounts,
            WormholeTokenBridgeEncoding.encodeTransferNative(nonce, amount, fee, targetAddress, targetChain)
        );
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
        uint16 targetChain
    ) external {
        _invoke(splTokenProgramId, approveAccounts, _encodeSplApprove(approveAmount));
        _invoke(
            tokenBridgeProgramId,
            transferAccounts,
            WormholeTokenBridgeEncoding.encodeTransferWrapped(nonce, amount, fee, targetAddress, targetChain)
        );
    }

    function claimCompleteNative(bytes32 tokenBridgeProgramId, ICrossProgramInvocation.AccountMeta[] calldata accounts)
        external
    {
        _invoke(tokenBridgeProgramId, accounts, WormholeTokenBridgeEncoding.encodeCompleteNative());
    }

    function claimCompleteWrapped(bytes32 tokenBridgeProgramId, ICrossProgramInvocation.AccountMeta[] calldata accounts)
        external
    {
        _invoke(tokenBridgeProgramId, accounts, WormholeTokenBridgeEncoding.encodeCompleteWrapped());
    }

    /// @notice Token Bridge `authority_signer` PDA (delegate target for SPL approve before transfer).
    function authoritySignerPda(bytes32 tokenBridgeProgramId) external view returns (bytes32) {
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

    function _authoritySignerPda(bytes32 tokenBridgeProgramId) internal view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](1);
        seeds[0] = ISystemProgram.Seed(bytes("authority_signer"));
        (bytes32 key,) = SystemProgram.find_program_address(tokenBridgeProgramId, seeds);
        return key;
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

    function _invoke(bytes32 programId, ICrossProgramInvocation.AccountMeta[] calldata accounts, bytes memory data)
        internal
    {
        if (accounts.length == 0) revert EmptyAccounts();
        ICrossProgramInvocation.AccountMeta[] memory m = new ICrossProgramInvocation.AccountMeta[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            m[i] = accounts[i];
        }
        CpiProgram.invoke(programId, m, data);
    }
}
