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
        // Use Yul to build the delegatecall data directly from calldata,
        // avoiding Solidity's expensive copy+encode cycle for tuple arrays.
        // Layout: selector(4) + programId(32) + accountsOffset(32) + dataOffset(32) + accounts... + data...
        address target = address(CpiProgram);
        bytes4 sel = ICrossProgramInvocation.invoke.selector;
        assembly {
            let acLen := accounts.length
            // Each AccountMeta = (bytes32, bool, bool) = 3 * 32 = 96 bytes
            let acDataLen := mul(acLen, 96)

            // data is a memory bytes: length at data, content at data+32
            let dataLen := mload(data)

            // Calculate total size of the delegatecall payload
            // selector(4) + programId(32) + acOffset(32) + dataOffset(32)
            // + acArrayLen(32) + acData + dataLen(32) + dataPadded
            let dataPadded := and(add(dataLen, 31), not(31))
            let totalLen := add(164, add(acDataLen, add(32, dataPadded)))

            let ptr := mload(0x40)
            // selector
            mstore(ptr, sel)
            // programId
            mstore(add(ptr, 4), programId)
            // offset to accounts array (3 * 32 = 96 from start of params)
            mstore(add(ptr, 36), 96)
            // offset to data bytes
            mstore(add(ptr, 68), add(128, acDataLen))
            // accounts array length
            mstore(add(ptr, 100), acLen)
            // copy accounts from calldata
            calldatacopy(add(ptr, 132), accounts.offset, acDataLen)
            // data length
            mstore(add(ptr, add(132, acDataLen)), dataLen)
            // copy data content from memory
            let dataSrc := add(data, 32)
            let dataDst := add(ptr, add(164, acDataLen))
            for { let i := 0 } lt(i, dataLen) { i := add(i, 32) } {
                mstore(add(dataDst, i), mload(add(dataSrc, i)))
            }

            let ok := delegatecall(gas(), target, ptr, totalLen, 0, 0)
            if iszero(ok) {
                returndatacopy(ptr, 0, returndatasize())
                revert(ptr, returndatasize())
            }
        }
    }

    function _invokeSigned(
        bytes32 programId,
        ICrossProgramInvocation.AccountMeta[] calldata accounts,
        bytes memory data,
        bytes32 salt
    ) internal {
        if (accounts.length == 0) revert EmptyAccounts();
        // Yul-optimized: builds invoke_signed delegatecall data directly.
        // Layout: selector(4) + programId(32) + acOffset(32) + dataOffset(32) + seedsOffset(32)
        //       + accounts(len+data) + data(len+padded) + seeds(len+salt)
        address target = address(CpiProgram);
        bytes4 sel = ICrossProgramInvocation.invoke_signed.selector;
        assembly {
            let acLen := accounts.length
            let acDataLen := mul(acLen, 96)

            let dataLen := mload(data)
            let dataPadded := and(add(dataLen, 31), not(31))

            // seeds: 1 element (the salt), each element is bytes32 = 32 bytes
            let seedsDataLen := 32

            // Calculate offsets (relative to start of params, i.e., after selector)
            // params start at byte 4
            // param0: programId at 0
            // param1: acOffset at 32
            // param2: dataOffset at 64
            // param3: seedsOffset at 96
            let acStart := 128 // 4 params * 32
            let dataStart := add(acStart, add(32, acDataLen))
            let seedsStart := add(dataStart, add(32, dataPadded))
            let totalLen := add(4, add(seedsStart, add(32, seedsDataLen)))

            let ptr := mload(0x40)
            mstore(ptr, sel)
            mstore(add(ptr, 4), programId)
            mstore(add(ptr, 36), acStart)
            mstore(add(ptr, 68), dataStart)
            mstore(add(ptr, 100), seedsStart)

            // accounts
            mstore(add(ptr, add(4, acStart)), acLen)
            calldatacopy(add(ptr, add(36, acStart)), accounts.offset, acDataLen)

            // data
            mstore(add(ptr, add(4, dataStart)), dataLen)
            let dataSrc := add(data, 32)
            let dataDst := add(ptr, add(36, dataStart))
            for { let i := 0 } lt(i, dataLen) { i := add(i, 32) } {
                mstore(add(dataDst, i), mload(add(dataSrc, i)))
            }

            // seeds array: length 1, element = salt
            mstore(add(ptr, add(4, seedsStart)), 1)
            mstore(add(ptr, add(36, seedsStart)), salt)

            let ok := delegatecall(gas(), target, ptr, totalLen, 0, 0)
            if iszero(ok) {
                returndatacopy(ptr, 0, returndatasize())
                revert(ptr, returndatasize())
            }
        }
    }
}
