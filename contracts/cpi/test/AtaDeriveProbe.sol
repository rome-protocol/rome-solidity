// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {UserPda} from "../UserPda.sol";

/// Test-only probe: exposes the legacy-seeded and program-aware raw-pubkey
/// ATA derivations side by side so a live chain can evidence the bridge-out
/// fix — for a Token-2022 mint `oldDerive` produces the wrong (legacy-seeded)
/// address while `newDerive` matches the address the create-leg makes;
/// for legacy mints the two are byte-identical.
contract AtaDeriveProbe {
    function oldDerive(bytes32 ownerKey, bytes32 mint) external pure returns (bytes32) {
        return UserPda.ataForKey(ownerKey, mint);
    }

    function newDerive(bytes32 ownerKey, bytes32 mint) external view returns (bytes32) {
        return UserPda.ataForKeyProgramAware(ownerKey, mint);
    }
}
