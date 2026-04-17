// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    ISystemProgram,
    ICrossProgramInvocation,
    SystemProgram,
    CpiProgram
} from "../interface.sol";

/// @title WrappedTokenView
/// @notice Minimal read-only ERC-20 wrapper over a Wormhole-minted wrapped SPL
///         token so MetaMask (or any ERC-20 UI) can display the balance of the
///         user's Rome-PDA-owned ATA.
/// @dev    Transfers revert. This is a view shim — it does not move tokens.
///         It skips `SplToken.program_id()` (unimplemented on maximus) by
///         hardcoding the SPL Token / Associated Token / Rome EVM program ids.
contract WrappedTokenView {
    // SPL Token program id (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA).
    bytes32 private constant SPL_TOKEN_PROGRAM =
        0x06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9;

    // Associated Token program id (ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL).
    bytes32 private constant ATA_PROGRAM =
        0x8c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859;

    // Rome EVM program id on maximus (CX3vRqzv1y7EEf3zr7myXz7UnwJMf2GiP1fUZZpVynSs).
    bytes32 private constant ROME_EVM_PROGRAM =
        0xab234890221792c8ed9019951c1f4bf22f355b307b10faac9aeadc06b960a310;

    bytes32 public immutable mint_id;
    string public name;
    string public symbol;
    uint8 public immutable decimals;

    constructor(bytes32 _mint_id, string memory _name, string memory _symbol, uint8 _decimals) {
        mint_id = _mint_id;
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    /// @notice Return the user's Rome PDA (seeds = ["EXTERNAL_AUTHORITY", evmAddr]).
    function userPda(address user) public view returns (bytes32) {
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](2);
        seeds[0] = ISystemProgram.Seed(bytes("EXTERNAL_AUTHORITY"));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(user));
        (bytes32 key,) = SystemProgram.find_program_address(ROME_EVM_PROGRAM, seeds);
        return key;
    }

    /// @notice Return the Associated Token Account of the user's Rome PDA for `mint_id`.
    function ata(address user) public view returns (bytes32) {
        bytes32 owner = userPda(user);
        ISystemProgram.Seed[] memory seeds = new ISystemProgram.Seed[](3);
        seeds[0] = ISystemProgram.Seed(abi.encodePacked(owner));
        seeds[1] = ISystemProgram.Seed(abi.encodePacked(SPL_TOKEN_PROGRAM));
        seeds[2] = ISystemProgram.Seed(abi.encodePacked(mint_id));
        (bytes32 key,) = SystemProgram.find_program_address(ATA_PROGRAM, seeds);
        return key;
    }

    /// @notice ERC-20 balance — reads the user PDA's ATA on Solana and returns the
    ///         u64 amount. Returns 0 when the ATA doesn't exist or is too small to
    ///         be an SPL Token Account.
    function balanceOf(address user) external view returns (uint256) {
        (,,,,, bytes memory data) = CpiProgram.account_info(ata(user));
        if (data.length < 72) return 0;
        // SPL Token Account: [mint(32) | owner(32) | amount(u64 LE @ offset 64)]
        uint64 amount = 0;
        for (uint256 i = 0; i < 8; i++) {
            amount |= uint64(uint8(data[64 + i])) << uint64(8 * i);
        }
        return uint256(amount);
    }

    /// @notice Stub — the SPL mint's totalSupply lives on Solana. We don't need
    ///         it for MetaMask balance display, so return 0.
    function totalSupply() external pure returns (uint256) {
        return 0;
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    function approve(address, uint256) external pure returns (bool) {
        revert("Read-only wrapper");
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert("Read-only wrapper");
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert("Read-only wrapper");
    }

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}
