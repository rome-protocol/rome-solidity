// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SplTokenLib} from "../spl_token.sol";

/// Test-only wrapper: SplTokenLib is a pure library consumed internally by
/// the wrappers; this harness exposes it so the parse boundary runs on the
/// simulated EVM with real mint bytes (no Rome chain needed).
contract SplTokenLibHarness {
    function parseMint(bytes calldata data, bytes32 token)
        external
        pure
        returns (uint8 decimals, bool isInitialized, uint64 supply)
    {
        SplTokenLib.SplMint memory mint = SplTokenLib.parseMint(data, token);
        return (mint.decimals, mint.is_initialized, mint.supply);
    }

    function checkMintOwner(bytes32 owner, bytes32 token) external pure {
        SplTokenLib.check_mint_owner(owner, token);
    }
}
