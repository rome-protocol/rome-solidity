// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MintNameReader} from "../MintNameReader.sol";

/// @notice Exposes `MintNameReader` to tests.
contract MintNameReaderHarness {
    function parse(bytes32 owner, bytes calldata data)
        external
        pure
        returns (bool ok, bytes32 authority, bytes32 pointer, uint256 entryOffset)
    {
        MintNameReader.Parsed memory m = MintNameReader.parse(owner, data);
        return (m.ok, m.mintAuthority, m.metadataAddress, m.metadataOffset);
    }

    function read(address cpi, bytes32 mint) external view returns (uint8 source, bytes memory name, bytes memory symbol) {
        MintNameReader.Source s;
        (s, name, symbol) = MintNameReader.read(cpi, mint);
        source = uint8(s);
    }

    function readAsAuthority(address cpi, bytes32 mint, bytes32 authority)
        external
        view
        returns (bool isAuthority, uint8 source, bytes memory name, bytes memory symbol)
    {
        MintNameReader.Source s;
        (isAuthority, s, name, symbol) = MintNameReader.readAsAuthority(cpi, mint, authority);
        source = uint8(s);
    }
}
